import { defineHook } from "@directus/extensions-sdk";

export default defineHook(({ action }, { services, logger, env }) => {
  const { AssetsService, FilesService } = services;
  const quality = env.EXTENSIONS_SANE_IMAGE_SIZE_UPLOAD_QUALITY ?? 75;
  const maxSize = env.EXTENSIONS_SANE_IMAGE_SIZE_MAXSIZE ?? 1920;
  const watermarkPath = '/directus/extensions/directus-extension-sane-image-size/watermark.png';
  const watermarkSizePercent = 20; // Watermark size as percentage of the image width
  const minWatermarkWidth = 100; // Minimum watermark width in pixels

  action("files.upload", async ({ payload, key }, context) => {
    if (payload.optimized !== true) {
      const serviceOptions = { ...context, knex: context.database };
      const assets = new AssetsService(serviceOptions);
      const files = new FilesService(serviceOptions);

      try {
        // Step 1: Resize (if necessary) and convert to AVIF
        const transformation = getTransformation(quality, maxSize);
        const { stream: avifStream, stat } = await assets.getAsset(key, transformation);

        logger.info(`Processed image dimensions: ${stat.width}x${stat.height}`);

        // Step 2: Apply watermark
        const watermarkTransformation = getWatermarkTransformation(watermarkPath, stat.width, stat.height, watermarkSizePercent, minWatermarkWidth);
        logger.info(`Watermark transformation: ${JSON.stringify(watermarkTransformation)}`);

        const { stream: finalStream, stat: finalStat } = await assets.getAsset(key, watermarkTransformation, avifStream);

        if (finalStat.size < payload.filesize) {
          await sleep(4000);

          // Delete existing thumbnail metadata
          delete payload.width;
          delete payload.height;
          delete payload.filesize;

          // Update file metadata
          payload.type = 'image/avif';
          payload.filename_download = payload.filename_download.replace(/\.[^/.]+$/, ".avif");

          await files.uploadOne(
            finalStream,
            {
              ...payload,
              optimized: true,
            },
            key,
            { emitEvents: false }
          );
          logger.info(`File ${key} successfully converted to AVIF with fitted watermark`);
        } else {
          logger.info(`Skipped optimization for ${key}: new file size not smaller`);
        }
      } catch (error) {
        logger.error(`Error processing file ${key}: ${error.message}`);
        logger.error(`Error stack: ${error.stack}`);
      }
    }
  });
});

function getTransformation(quality, maxSize) {
  return {
    transformationParams: {
      format: 'avif',
      quality,
      width: maxSize,
      height: maxSize,
      fit: "inside",
      withoutEnlargement: true,
      transforms: [
        ['avif', { quality }]
      ],
    },
  };
}

function getWatermarkTransformation(watermarkPath, imageWidth, imageHeight, watermarkSizePercent, minWatermarkWidth) {
  let watermarkWidth = Math.round(imageWidth * (watermarkSizePercent / 100));
  
  // Ensure watermark is not smaller than minWatermarkWidth
  watermarkWidth = Math.max(watermarkWidth, minWatermarkWidth);
  
  // Ensure watermark is not larger than the image
  watermarkWidth = Math.min(watermarkWidth, imageWidth);

  return {
    transformationParams: {
      transforms: [
        ['composite', [{
          input: watermarkPath,
          gravity: 'center',
          resize: {
            width: watermarkWidth,
            height: Math.round(watermarkWidth * (imageHeight / imageWidth)),
            fit: 'inside'
          }
        }]],
      ],
    },
  };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
