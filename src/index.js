import { defineHook } from "@directus/extensions-sdk";

export default defineHook(({ action }, { services, logger, env }) => {
  const { AssetsService, FilesService } = services;
  const quality = 75; // Fixed quality for AVIF
  const maxSize = env.EXTENSIONS_SANE_IMAGE_SIZE_MAXSIZE ?? 1920;
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
            payload.width = stat.width;
            payload.height = stat.height;
            payload.filesize = stat.size;
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
            logger.info(`File ${key} successfully converted to AVIF with fitted watermark`);
          } else {
            logger.info(`AVIF conversion for ${key} skipped: new file size not smaller`);
          }
        } catch (error) {
          logger.error(`Error processing file ${key}: ${error.message}`);
        }
      }
    }
  });
});

function getTransformation(type, quality, maxSize, watermarkPath) {
  const format = type.split("/")[1] ?? "";
  if (["jpg", "jpeg", "png", "webp"].includes(format)) {
    return {
      transformationParams: {
        format: 'avif',
        quality,
        width: maxSize,
        height: maxSize,
        fit: "inside",
        withoutEnlargement: true,
        transforms: [
          ['withMetadata'],
          ['resize', { width: maxSize, height: maxSize, fit: 'inside', withoutEnlargement: true }],
          ['composite', [{
            input: watermarkPath,
            gravity: 'center',
            fit: 'inside',
            width: Math.floor(maxSize * 0.9),  // Watermark width 50% of max size
            height: Math.floor(maxSize * 0.9)  // Watermark height 50% of max size
          }]],
          ['avif', { quality }]
        ],
      },
    };
  }
  return undefined;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
