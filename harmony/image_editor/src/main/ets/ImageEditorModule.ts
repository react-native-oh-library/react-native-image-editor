/*
 * MIT License
 *
 * Copyright (C) 2023 Huawei Device Co., Ltd.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { TurboModule } from 'rnoh/ts'
import Logger from './Logger'
import http from '@ohos.net.http'
import ResponseCode from '@ohos.net.http'
import image from '@ohos.multimedia.image'
import { BusinessError } from '@ohos.base'

import util from '@ohos.util'
import fs from '@ohos.file.fs'
import buffer from '@ohos.buffer'
import common from '@ohos.app.ability.common'

interface size {
  width: number;
  height: number;
}
interface offset {
  x: number;
  y: number;
}
interface ImageCropData {
  offset: offset;
  size: size;
  displaySize?: size;
  resizeMode?: string;
  quality?: number | undefined;
  format?: string;
  includeBase64?: boolean;
}
interface EditorResult {
  uri: string;
  path: string;
  name: string;
  width: number;
  height: number;
  size: number;
  type: string;
  base64?: string
}

const context = getContext(this) as common.ApplicationContext

let newOptions: ImageCropData = {
  offset: {x: 0, y: 0},
  size: {width: 0, height: 0},
  resizeMode: 'cover',
  includeBase64: false,
}

let resizeScaleSize: size = {
  width: 0,
  height: 0
}

async function loadBase(uri: string) {
  return new Promise((resolve)=>{
    let buf = buffer.alloc(uri.length, uri)
    resolve(buf.buffer)
  })
}
function loadHttp(uri: string)  {
  return new Promise((resolve, reject)=>{
    http.createHttp().request(uri,{
      header: {
        'Content-Type': 'application/octet-stream'
      }
    },
    async (error: BusinessError, data: http.HttpResponse) => {
      let code: http.ResponseCode | number = data.responseCode
      if (ResponseCode.ResponseCode.OK === code) {
        const imageData = data.result as ArrayBuffer
        Logger.info("http.createHttp success")
        resolve(imageData)
      } else {
        Logger.error("http.createHttp error is " + error)
      }
    })
  })
}

async function getUriBuffer(uri: string) {
  let imageBuffer = null
  if(uri.startsWith("data:")){
    imageBuffer = await loadBase(uri)
  } else if(uri.startsWith('http')) {
    imageBuffer = await loadHttp(uri)
  } else {
    imageBuffer = uri
  }
  return imageBuffer
}

async function imageEditor(imageData): Promise<EditorResult> {
  let imageSourceApi: image.ImageSource = image.createImageSource(imageData)
  let getImageInfo: image.ImageInfo
  let options: Record<string, number | boolean> = {
    'editable': true,
  }
  let editorPM = await imageSourceApi.createPixelMap(options)  

  editorPM.getImageInfo().then((imageInfo: image.ImageInfo) => {
		if(newOptions.offset.x+newOptions.size.width > imageInfo.size.width || newOptions.offset.y+newOptions.size.height > imageInfo.size.height){
      Logger.error('[RNOH]:The cropped size exceeds the original size')
      return
    }
	})

  const x = newOptions.offset.x
  const y = newOptions.offset.y
  const width = newOptions.size.width
  const height = newOptions.size.height
  let region: image.Region = { x, y, size: {height, width}}

  await editorPM.crop(region).then(() => {
      Logger.info('imageEditor.Succeeded in crop.');
    }).catch((error: BusinessError) => {
      Logger.error('imageEditor.Failed to crop.');
    })

  if(newOptions.displaySize && newOptions.displaySize.width && newOptions.displaySize.height){

    const cropSize = newOptions.size
    const displaySize = JSON.parse(JSON.stringify(newOptions.displaySize))
    const aspect = cropSize.width / cropSize.height
    const targetAspect = displaySize.width / displaySize.height
    if(aspect === targetAspect) newOptions.resizeMode = 'stretch'
    
    const xRatio = displaySize.width / cropSize.width
    const yRatio = displaySize.height / cropSize.height
    if(newOptions.resizeMode === 'stretch'){
      await editorPM.scale(xRatio, yRatio)
    } else if(newOptions.resizeMode === 'cover'){
      if(displaySize.width !== cropSize.width || displaySize.height !== cropSize.height){
        const ratio = Math.max(xRatio, yRatio)
        await editorPM.scale(ratio, ratio)

        await editorPM.getImageInfo().then((imageInfo: image.ImageInfo) => {
          resizeScaleSize = imageInfo.size
        })
      }

      const targetRegion = await TargetRect()
      await editorPM.crop(targetRegion).then(() => {
        Logger.info('imageEditor.Succeeded in crop.');
      }).catch((error: BusinessError) => {
        Logger.error('imageEditor.Failed to crop.');
      })

    } else {
      const { size } = await TargetRect()
      const xRatio = size.width / cropSize.width
      const yRatio = size.height / cropSize.height
      await editorPM.scale(xRatio, yRatio)
    }
    
  }
  await editorPM.getImageInfo().then((imageInfo: image.ImageInfo) => {
		getImageInfo = imageInfo
	})

  let suffix = newOptions.format
  suffix = suffix === 'jpeg' || suffix === 'jpg' ? 'jpeg' : suffix
  const fileName = `ReactNative_cropped_image_${new Date().getTime()}.${suffix==='jpeg'?'jpg':suffix}`
  const path: string = `${context.cacheDir}/${fileName}`
  let packOpts: image.PackingOption = { format: `image/${suffix}`, quality: newOptions.quality || 90 }
  let file = await fs.openSync(path, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE);
  let size = 0
  let base64Data = ''

  const imagePackerApi:image.ImagePacker = image.createImagePacker()
  await imagePackerApi.packing(editorPM, packOpts)
    .then(async (data: ArrayBuffer) => {
      let writeLen = await fs.writeSync(file.fd, data)
      size = writeLen
      fs.closeSync(file)

      if(newOptions.includeBase64){
        let unit8Array: Uint8Array = new Uint8Array(data)
        let base64Helper = new util.Base64Helper()
        base64Data = await base64Helper.encodeToStringSync(unit8Array, util.Type.BASIC)
      }

    }).catch((error: BusinessError) => {
      Logger.error('packing failed.');
    })

  editorPM.release()
  imageSourceApi.release()
  imagePackerApi.release()

  size = await fs.statSync(path).size;

  const result:EditorResult = {
    uri: `file://${path}`,
    path: path,
    name: fileName,
    width: getImageInfo.size.width,
    height: getImageInfo.size.height,
    size: size,
    type: `image/${suffix}`,
  }
  if(newOptions.includeBase64){
    result.base64 = base64Data
  }
  return result;
}

async function TargetRect() {
  const resizeMode = newOptions.resizeMode
  const cropSize = newOptions.size
  const displaySize = JSON.parse(JSON.stringify(newOptions.displaySize))
  const aspect = cropSize.width / cropSize.height
  const targetAspect = displaySize.width / displaySize.height
  const targetSize = JSON.parse(JSON.stringify(cropSize))
  let targetRegion = {x: 0, y:0, size: targetSize}

  if(resizeMode === 'cover'){
    if(targetAspect <= aspect){
      const translation = (resizeScaleSize.width - displaySize.width) / 2
      targetRegion.x = Math.abs(translation)
    } else {
      const translation = (resizeScaleSize.height - displaySize.height) / 2
      targetRegion.y = Math.abs(translation)
    }
    targetRegion.size = displaySize
  } else if(resizeMode === 'contain') {
    if(targetAspect <= aspect) {
      targetSize.width = displaySize.width
      targetSize.height = Math.ceil(targetSize.width / aspect)
    } else {
      targetSize.height = displaySize.height
      targetSize.width = Math.ceil(targetSize.height * aspect)
    }
  } else if(resizeMode === 'center') {
    if(cropSize.height > displaySize.height) {
      targetSize.width = displaySize.width
      targetSize.height = Math.ceil(targetSize.width / aspect)
    } 
    if(cropSize.width > displaySize.width) {
      targetSize.height = displaySize.height
      targetSize.width = Math.ceil(targetSize.height * aspect)
    }
  }
  targetRegion.size = targetSize
  return targetRegion
}

export class ImageEditorModule extends TurboModule {
  async cropImage(uri: string, options: ImageCropData): Promise<string>{
    const offset = options.offset
    const size = options.size
    let quality = 90
    if (options.quality) {
      quality = Math.floor(options.quality * 100)
    }
    if(!uri){
      Logger.warn('[RNOH]:Please specify a URI');
      return
    }
    if(!offset || !size || !('x' in offset) || !('y' in offset) || !size.width || !size.height){
      Logger.warn('[RNOH]:Please specify offset and size');
      return
    }
    if(quality > 100 || quality < 0){
      Logger.warn('[RNOH]:quality must be a number between 0 and 1');
      return
    }

    newOptions.size = size
    newOptions.offset = offset
    newOptions.quality = quality
    if(options.displaySize) newOptions.displaySize = options.displaySize
    if(options.resizeMode) newOptions.resizeMode = options.resizeMode
    if(options.format) {
      newOptions.format = options.format
    } else {
      const uris = uri.split('.')
      newOptions.format = uris.length > 1 ? uris[uris.length-1] : 'jpeg'
    }
    if(options.includeBase64) newOptions.includeBase64 = options.includeBase64

    const buffer = await getUriBuffer(uri)
    const fileUri: EditorResult = await imageEditor(buffer)

    return fileUri.uri

  }
}