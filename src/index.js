import { defineHook } from "@directus/extensions-sdk";

export default defineHook(({ action }, { services, logger, env }) => {
  const { AssetsService, FilesService } = services;
  const quality = 75; // Changed to fixed quality of 75 for AVIF
  const maxSize = env.EXTENSIONS_SANE_IMAGE_SIZE_MAXSIZE ?? 1920;
  const watermarkPath = '/directus/extensions/directus-extension-sane-image-size/watermark.png';

  action("files.upload", async ({ payload, key }, context) => {
    if (payload.optimized !== true) {
      const transformation = getTransformation(payload.type, quality, maxSize);
      if (transformation !== undefined) {
        try {
          const serviceOptions = { ...context, knex: context.database };
          const assets = new AssetsService(serviceOptions);
          const files = new FilesService(serviceOptions);

          const { stream, stat } = await assets.getAsset(key, transformation);
          
          // Apply watermark
          const watermarkedStream = await applyWatermark(stream, watermarkPath);

          if (stat.size < payload.filesize) {
            await sleep(4000);

            // Check for existing thumbnails
            delete payload.width;
            delete payload.height;
            delete payload.size;

            files.uploadOne(
              watermarkedStream,
              {
                ...payload,
                optimized: true,
                type: 'image/avif', // Set MIME type to AVIF
              },
              key,
              { emitEvents: false }
            );
          }
        } catch (error) {
          logger.error(`Error processing image: ${error.message}`);
        }
      }
    }
  });
});

function getTransformation(type, quality, maxSize) {
  const format = type.split("/")[1] ?? "";
  if (["jpg", "jpeg", "png", "webp", "avif"].includes(format)) {
    return {
      transformationParams: {
        format: 'avif', // Always convert to AVIF
        quality,
        width: maxSize,
        height: maxSize,
        fit: "inside",
        withoutEnlargement: true,
        transforms: [
          ['withMetadata'],
          ['avif', { quality }],
        ],
      },
    };
  }
  return undefined;
}

async function applyWatermark(inputStream, watermarkPath) {
  try {
    const sharp = require('sharp');
    const image = sharp(await streamToBuffer(inputStream));
    const watermark = sharp(watermarkPath);

    const imageMetadata = await image.metadata();

    // Resize watermark to match the exact dimensions of the target image
    const resizedWatermark = await watermark
      .resize(imageMetadata.width, imageMetadata.height, { fit: 'fill' })
      .toBuffer();

    return image
      .composite([
        {
          input: resizedWatermark,
          blend: 'over', // This ensures the watermark's transparency is respected
        },
      ])
      .toBuffer();
  } catch (error) {
    logger.error(`Error applying watermark: ${error.message}`);
    return inputStream;
  }
}

async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
