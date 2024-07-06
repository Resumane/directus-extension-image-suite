import { defineHook } from "@directus/extensions-sdk";
import sharp from 'sharp';

export default defineHook(({ action }, { services, logger, env }) => {
  const { AssetsService, FilesService } = services;
  const quality = env.EXTENSIONS_SANE_IMAGE_SIZE_UPLOAD_QUALITY ?? 75;
  const maxSize = env.EXTENSIONS_SANE_IMAGE_SIZE_MAXSIZE ?? 1920;
  const watermarkPath = '/directus/extensions/directus-extension-sane-image-size/watermark.png';

  action("files.upload", async ({ payload, key }, context) => {
    if (payload.optimized !== true) {
      const serviceOptions = { ...context, knex: context.database };
      const assets = new AssetsService(serviceOptions);
      const files = new FilesService(serviceOptions);
      
      try {
        // Get the original image
        const { stream: originalStream } = await assets.getAsset(key, {});
        const originalBuffer = await streamToBuffer(originalStream);

        // Process the image
        const processedImage = await sharp(originalBuffer)
          .resize({
            width: maxSize,
            height: maxSize,
            fit: 'inside',
            withoutEnlargement: true
          })
          .composite([{
            input: watermarkPath,
            gravity: 'center',
            fit: 'inside',
            width: Math.floor(maxSize),  // Watermark width 20% of max size
            height: Math.floor(maxSize)  // Watermark height 20% of max size
          }])
          .avif({ quality })
          .toBuffer({ resolveWithObject: true });

        // Check if the new file is smaller
        if (processedImage.info.size < payload.filesize) {
          // Update file metadata
          payload.width = processedImage.info.width;
          payload.height = processedImage.info.height;
          payload.filesize = processedImage.info.size;
          payload.type = 'image/avif';
          payload.filename_download = payload.filename_download.replace(/\.[^/.]+$/, ".avif");

          await files.uploadOne(
            processedImage.data,
            {
              ...payload,
              optimized: true,
            },
            key,
            { emitEvents: false }
          );
          logger.info(`File ${key} successfully converted to AVIF with fitted watermark`);
        } else {
          logger.info(`AVIF conversion for ${key} skipped: new file size not smaller`);
        }
      } catch (error) {
        logger.error(`Error processing file ${key}: ${error.message}`);
      }
    }
  });
});

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
