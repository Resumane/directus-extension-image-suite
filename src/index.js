import { defineHook } from "@directus/extensions-sdk";

export default defineHook(({ action }, { services, logger, env }) => {
  const { AssetsService, FilesService } = services;
  const quality = 75;
  const maxSize = env.EXTENSIONS_SANE_IMAGE_SIZE_MAXSIZE ?? 1920;
  const watermarkPath = '/directus/extensions/directus-extension-sane-image-size/watermark.png';

  action("files.upload", async ({ payload, key }, context) => {
    if (payload.optimized !== true) {
      try {
        const serviceOptions = { ...context, knex: context.database };
        const assets = new AssetsService(serviceOptions);
        const files = new FilesService(serviceOptions);

        // Get the original asset
        const { stream: originalStream } = await assets.getAsset(key, {});
        
        // Convert the original stream to a buffer
        const originalBuffer = await streamToBuffer(originalStream);

        // Process the image
        const processedBuffer = await processImage(originalBuffer, watermarkPath, quality, maxSize, context.sharp, logger);

        if (processedBuffer && processedBuffer.length < payload.filesize) {
          await sleep(4000);

          delete payload.width;
          delete payload.height;
          delete payload.size;

          await files.uploadOne(
            processedBuffer,
            {
              ...payload,
              optimized: true,
              type: 'image/avif',
            },
            key,
            { emitEvents: false }
          );
        }
      } catch (error) {
        logger.error(`Error processing image: ${error.message}`);
      }
    }
  });
});

async function processImage(inputBuffer, watermarkPath, quality, maxSize, sharp, logger) {
  try {
    let image = sharp(inputBuffer);
    
    // Get metadata
    const metadata = await image.metadata();

    // Resize if necessary
    if (metadata.width > maxSize || metadata.height > maxSize) {
      image = image.resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true });
    }

    // Convert to AVIF
    image = image.avif({ quality });

    // Apply watermark
    const watermark = sharp(watermarkPath);
    const watermarkMetadata = await watermark.metadata();
    const resizedWatermark = await watermark
      .resize(metadata.width, metadata.height, { fit: 'fill' })
      .toBuffer();

    return image
      .composite([
        {
          input: resizedWatermark,
          blend: 'over',
        },
      ])
      .toBuffer();
  } catch (error) {
    logger.error(`Error processing image: ${error.message}`);
    return null;
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
