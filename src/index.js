import { defineHook } from "@directus/extensions-sdk";

export default defineHook(({ action }, { services, logger, env }) => {
  const { AssetsService, FilesService } = services;
  const quality = env.EXTENSIONS_SANE_IMAGE_SIZE_UPLOAD_QUALITY ?? 75;
  const maxSize = env.EXTENSIONS_SANE_IMAGE_SIZE_MAXSIZE ?? 1920;
  
  // Define the path to your watermark image
  const watermarkPath = '/directus/extensions/directus-extension-sane-image-size/watermark.png';

  action("files.upload", async ({ payload, key }, context) => {
    if (payload.optimized !== true) {
      const transformation = getTransformation(payload.type, quality, maxSize, watermarkPath);
      if (transformation !== undefined) {
        const serviceOptions = { ...context, knex: context.database };
        const assets = new AssetsService(serviceOptions);
        const files = new FilesService(serviceOptions);
        
        try {
          const { stream, stat } = await assets.getAsset(key, transformation);
          if (stat.size < payload.filesize) {
            await sleep(4000);
            // Update file metadata
            delete payload.width;
            delete payload.height;
            delete payload.size;
            payload.type = 'image/avif';
            payload.filename_download = payload.filename_download.replace(/\.[^/.]+$/, ".avif");
            
            await files.uploadOne(
              stream,
              {
                ...payload,
                optimized: true,
              },
              key,
              { emitEvents: false }
            );
            logger.info(`File ${key} successfully converted to AVIF with watermark`);
          } else {
            logger.info(`AVIF conversion for ${key} skipped: new file size not smaller`);
          }
        } catch (error) {
          logger.error(`Error processing file ${key}: ${error.message}`);
          logger.error(`Attempted watermark path: ${watermarkPath}`);
        }
      }
    }
  });
});

function getTransformation(type, quality, maxSize, watermarkPath) {
  const format = type.split("/")[1] ?? "";
  if (["jpg", "jpeg", "png", "webp", "avif"].includes(format)) {
    return {
      transformationParams: {
        format: 'avif',
        quality,
        width: maxSize,
        height: maxSize,
        fit: "inside",
        withoutEnlargement: true,
        transforms: [
          ["withMetadata"],
          ["composite", [{
            input: watermarkPath,
            gravity: 'center'
          }]]
        ],
      },
    };
  }
  return undefined;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
