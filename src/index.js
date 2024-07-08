import { defineHook } from "@directus/extensions-sdk";
import axios from 'axios';

export default defineHook(({ action }, { services, logger, env }) => {
  const { AssetsService, FilesService } = services;
  const QUALITY = 75; // Fixed quality for AVIF
  const MAX_SIZE = parseInt(env.EXTENSIONS_SANE_IMAGE_SIZE_MAXSIZE) || 1920;
  const WATERMARK_BASE_PATH = '/directus/extensions/directus-extension-sane-image-size/';
  const WATERMARKS = [
    { filename: 'watermark-1920.png', width: 1920, height: 1440 },
    { filename: 'watermark-1920-1080.png', width: 1920, height: 1080 },
    { filename: 'watermark-1900.png', width: 1900, height: 1425 },
    { filename: 'watermark-1850.png', width: 1850, height: 1387 },
    { filename: 'watermark-1800.png', width: 1800, height: 1350 },
    { filename: 'watermark-1700.png', width: 1700, height: 1275 },
    { filename: 'watermark-1600.png', width: 1600, height: 1200 },
    { filename: 'watermark-1500.png', width: 1500, height: 1125 },
    { filename: 'watermark-1400.png', width: 1400, height: 1050 },
    { filename: 'watermark-1200.png', width: 1200, height: 900 },
    { filename: 'watermark-1000.png', width: 1000, height: 750 },
    { filename: 'watermark-800.png', width: 800, height: 600 },
  ];
  const queue = [];
  let isProcessing = false;

  action("files.upload", async ({ payload, key }, context) => {
    if (!payload.optimized) {
      queue.push({ payload, key, context });
      if (!isProcessing) {
        processQueue();
      }
    }
  });

  async function processQueue() {
    if (queue.length === 0) {
      isProcessing = false;
      return;
    }
    isProcessing = true;
    const { payload, key, context } = queue.shift();
    
    try {
      await processImage(payload, key, context);
    } catch (error) {
      logger.error(`Error processing image: ${error.message}`);
    }
    // Process next item in queue
    processQueue();
  }

  async function processImage(payload, key, context) {
    const serviceOptions = { ...context, knex: context.database };
    const assets = new AssetsService(serviceOptions);
    const files = new FilesService(serviceOptions);
    
    try {
      const fileData = await files.readOne(key);
      const { width: originalWidth, height: originalHeight } = fileData;
      const resizedDimensions = calculateResizedDimensions(originalWidth, originalHeight, MAX_SIZE);
      const suitableWatermark = getSuitableWatermark(resizedDimensions.width, resizedDimensions.height);
      const combinedTransformation = getCombinedTransformation(payload.type, suitableWatermark);

      const { stream: finalStream, stat: finalStat } = await assets.getAsset(key, combinedTransformation);

      await sleep(4000);
      
      const newFilename = generateUniqueFilename();

      const updatedPayload = {
        ...payload,
        width: resizedDimensions.width,
        height: resizedDimensions.height,
        filesize: finalStat.size,
        type: 'image/avif',
        filename_download: newFilename,
        optimized: true,
      };
      
      await files.uploadOne(finalStream, updatedPayload, key, { emitEvents: false });

      // Wait for the file to be ready before requesting the thumbnail
      await waitForFileReady(key, files);

      // After the file is ready, request the thumbnail
      await requestThumbnail(key);
    } catch (error) {
      logger.error(`Error processing file ${key}: ${error.message}`);
    }
  }

  async function waitForFileReady(fileId, filesService, maxAttempts = 10, interval = 30000) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const fileData = await filesService.readOne(fileId);
        if (fileData && fileData.filename_disk) {
          logger.info(`File ${fileId} is ready after ${attempt + 1} attempts`);
          return;
        }
      } catch (error) {
        logger.warn(`Attempt ${attempt + 1}: File ${fileId} not ready yet. Error: ${error.message}`);
      }
      await sleep(interval);
    }
    throw new Error(`File ${fileId} not ready after ${maxAttempts} attempts`);
  }

  async function requestThumbnail(fileId) {
    const thumbnailUrl = `https://bluehorizoncondos.com/assets/${fileId}?key=carousel`;
    logger.info(`Requesting thumbnails for file ${fileId} at URL: ${thumbnailUrl}`);

    const formats = [
      { name: 'WebP', accept: 'image/webp' },
      { name: 'AVIF', accept: 'image/avif' }
    ];

    for (const format of formats) {
      try {
        const response = await axios.get(thumbnailUrl, {
          headers: {
            'Accept': `${format.accept},image/png,image/jpeg`
          },
          responseType: 'arraybuffer'
        });
        
        const contentType = response.headers['content-type'];
        logger.info(`Thumbnail generated for file ${fileId} in ${format.name} format. Status: ${response.status}, Content-Type: ${contentType}`);
        
        // Verify if the response is in the requested format
        if (contentType === format.accept) {
          logger.info(`Received ${format.name} image for file ${fileId}`);
        } else {
          logger.warn(`Requested ${format.name} but received ${contentType} for file ${fileId}`);
        }
      } catch (error) {
        logger.error(`Error generating ${format.name} thumbnail for file ${fileId}: ${error.message}`);
        logger.error(`Requested URL: ${thumbnailUrl}`);
        if (error.response) {
          logger.error(`Response status: ${error.response.status}`);
          logger.error(`Response headers: ${JSON.stringify(error.response.headers)}`);
        }
      }
    }
  }

  function getSuitableWatermark(imageWidth, imageHeight) {
    let bestWatermark = null;
    let bestArea = 0;

    for (const watermark of WATERMARKS) {
      if (watermark.width <= imageWidth && watermark.height <= imageHeight) {
        const area = watermark.width * watermark.height;
        if (area > bestArea) {
          bestArea = area;
          bestWatermark = watermark;
        }
      }
    }

    if (bestWatermark) {
      return {
        ...bestWatermark,
        path: WATERMARK_BASE_PATH + bestWatermark.filename,
        useWidth: bestWatermark.width,
        useHeight: bestWatermark.height
      };
    }

    return null;
  }

  function getCombinedTransformation(type, watermark) {
    const format = type.split("/")[1] ?? "";
    if (["jpg", "jpeg", "png", "webp"].includes(format)) {
      const transforms = [
        ['avif', { quality: QUALITY }]
      ];
      
      if (watermark) {
        transforms.push(['composite', [{
          input: watermark.path,
          gravity: 'center'
        }]]);
      }

      return {
        transformationParams: {
          format: 'avif',
          quality: QUALITY,
          width: MAX_SIZE,
          height: MAX_SIZE,
          fit: "inside",
          withoutEnlargement: true,
          transforms,
        },
      };
    }
    return undefined;
  }

  function calculateResizedDimensions(originalWidth, originalHeight, maxSize) {
    if (originalWidth <= maxSize && originalHeight <= maxSize) {
      return { width: originalWidth, height: originalHeight };
    }
    
    const aspectRatio = originalWidth / originalHeight;
    
    if (aspectRatio > 1) {
      return {
        width: maxSize,
        height: Math.round(maxSize / aspectRatio)
      };
    } else {
      return {
        width: Math.round(maxSize * aspectRatio),
        height: maxSize
      };
    }
  }

  function generateUniqueFilename() {
    const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const randomString = Math.random().toString(36).substring(2, 10);
    return `${timestamp}_${randomString}.avif`;
  }
});

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
