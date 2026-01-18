import { defineHook } from "@directus/extensions-sdk";
import axios from 'axios';

export default defineHook(({ action }, { services, logger, env }) => {
  const { AssetsService, FilesService } = services;
  const QUALITY = 75;
  const rawMaxSize = Number(env.EXTENSIONS_SANE_IMAGE_SIZE_MAXSIZE);
  const MAX_SIZE = Number.isFinite(rawMaxSize) && rawMaxSize > 0 ? Math.floor(rawMaxSize) : 1920;
  const WATERMARK_BASE_PATH = '/directus/extensions/directus-extension-sane-image-size/';
  const THUMBNAIL_BASE_URL = 'https://bluehorizoncondospattaya.com/assets';
  const THUMBNAIL_PRESETS = ['carousel'];

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
    } finally {
      // Process next item in queue regardless of success/failure
      setTimeout(() => processQueue(), 1000);
    }
  }

  async function processImage(payload, key, context) {
    const serviceOptions = { ...context, knex: context.database };
    const assets = new AssetsService(serviceOptions);
    const files = new FilesService(serviceOptions);
    
    try {
      const fileData = await files.readOne(key);
      
      // File existence is implicitly checked when operations are performed
      const originalWidth = Number(fileData.width);
      const originalHeight = Number(fileData.height);
      if (!Number.isFinite(originalWidth) || !Number.isFinite(originalHeight) || originalWidth <= 0 || originalHeight <= 0) {
        logger.warn(`Skipping processing for file ${key}: invalid dimensions width=${fileData.width}, height=${fileData.height}`);
        return;
      }
      const resizedDimensions = calculateResizedDimensions(originalWidth, originalHeight, MAX_SIZE);
      const suitableWatermark = getSuitableWatermark(resizedDimensions.width, resizedDimensions.height);
      const effectiveType = typeof payload.type === "string" ? payload.type : fileData.type;
      const combinedTransformation = getCombinedTransformation(effectiveType, suitableWatermark);

      // Skip processing if transformation is not applicable
      if (!combinedTransformation) {
        logger.info(`Skipping processing for file ${key} with type ${payload.type}`);
        return;
      }

      try {
        const { stream: finalStream, stat: finalStat } = await assets.getAsset(key, combinedTransformation);

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

        // Throttle sequential processing on smaller servers (adaptive delay based on output size)
        const sleepTime = Math.min(Math.max(finalStat.size / 100000 * 1000, 2000), 10000);
        logger.info(`Throttling ${sleepTime}ms after upload for file ${key} (size: ${finalStat.size} bytes)`);
        await sleep(sleepTime);

        // Wait briefly for the file record to settle before requesting the thumbnail
        await waitForFileReady(key, files, 2, 2000);

        // Request thumbnails for the carousel preset only
        await requestThumbnail(key, THUMBNAIL_PRESETS[0]);
      } catch (error) {
        // Handle potential errors from assets.getAsset
        logger.error(`Error getting asset for file ${key}: ${error.message}`);
        throw error; // Re-throw to be caught by the outer try/catch
      }
    } catch (error) {
      logger.error(`Error processing file ${key}: ${error.message}`);
      if (error.stack) {
        logger.error(`Stack trace: ${error.stack}`);
      }
    }
  }

  async function waitForFileReady(fileId, filesService, maxAttempts = 10, interval = 5000) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const fileData = await filesService.readOne(fileId);
        if (fileData && fileData.filename_disk) {
          // Instead of checking file existence directly, we just verify database record is complete
          logger.info(`File ${fileId} is ready in database after ${attempt + 1} attempts`);
          return;
        } else {
          logger.warn(`File ${fileId} record exists but filename_disk is not set`);
        }
      } catch (error) {
        logger.warn(`Attempt ${attempt + 1}: File ${fileId} not ready yet. Error: ${error.message}`);
      }
      
      if (attempt < maxAttempts - 1) {
        await sleep(interval);
      }
    }
    throw new Error(`File ${fileId} not ready after ${maxAttempts} attempts`);
  }

  async function requestThumbnail(fileId, preset, retryAttempts = 3) {
    const thumbnailUrl = `${THUMBNAIL_BASE_URL}/${fileId}?key=${preset}`;
    logger.info(`Requesting thumbnails for file ${fileId} with preset ${preset} at URL: ${thumbnailUrl}`);

    const formats = [
      { name: 'WebP', accept: 'image/webp' },
      { name: 'AVIF', accept: 'image/avif' }
    ];

    for (const format of formats) {
      let success = false;
      
      for (let attempt = 0; attempt < retryAttempts && !success; attempt++) {
        try {
          const response = await axios.get(thumbnailUrl, {
            headers: {
              'Accept': `${format.accept},image/png,image/jpeg`
            },
            responseType: 'stream',
            timeout: 10000 // 10 second timeout
          });
          
          const contentType = response.headers['content-type'];
          logger.info(`Thumbnail generated for file ${fileId} with preset ${preset} in ${format.name} format. Status: ${response.status}, Content-Type: ${contentType}`);
          await drainStream(response.data);
          
          if (contentType === format.accept) {
            logger.info(`Received ${format.name} image for file ${fileId} with preset ${preset}`);
            success = true;
          } else {
            logger.warn(`Requested ${format.name} but received ${contentType} for file ${fileId} with preset ${preset}`);
            
            if (attempt < retryAttempts - 1) {
              logger.info(`Retrying ${format.name} generation (attempt ${attempt + 1}/${retryAttempts})`);
              await sleep(1000 * (attempt + 1)); // Exponential backoff
            }
          }
        } catch (error) {
          logger.error(`Error generating ${format.name} thumbnail for file ${fileId} with preset ${preset}: ${error.message}`);
          logger.error(`Requested URL: ${thumbnailUrl}`);
          
          if (error.response) {
            logger.error(`Response status: ${error.response.status}`);
            logger.error(`Response headers: ${JSON.stringify(error.response.headers)}`);
          }
          
          if (attempt < retryAttempts - 1) {
            logger.info(`Retrying after error (attempt ${attempt + 1}/${retryAttempts})`);
            await sleep(2000 * (attempt + 1)); // Longer backoff after errors
          }
        }
      }
      
      if (!success) {
        logger.warn(`Failed to generate ${format.name} thumbnail after ${retryAttempts} attempts`);
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
      // We don't verify watermark existence directly anymore
      // Instead, we'll handle any errors that occur when using the watermark
      const watermarkPath = WATERMARK_BASE_PATH + bestWatermark.filename;      
      return {
        ...bestWatermark,
        path: watermarkPath,
        useWidth: bestWatermark.width,
        useHeight: bestWatermark.height
      };
    }

    return null;
  }

  function getCombinedTransformation(type, watermark) {
    if (typeof type !== "string") {
      return undefined;
    }
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

async function drainStream(stream) {
  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.resume();
  });
}
