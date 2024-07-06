import { defineHook } from "@directus/extensions-sdk";

export default defineHook(({ action }, { services, logger, env }) => {
  const { AssetsService, FilesService } = services;
  const quality = 75; // Fixed quality for AVIF
  const maxSize = env.EXTENSIONS_SANE_IMAGE_SIZE_MAXSIZE ?? 1920;
  const queue = [];
  let isProcessing = false;

  action("files.upload", async ({ payload, key }, context) => {
    if (payload.optimized !== true) {
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
      await processImage(payload, key, context, services, quality, maxSize);
    } catch (error) {
      logger.error(`Error processing image: ${error.message}`);
    }

    // Process next item in queue
    processQueue();
  }
});

async function processImage(payload, key, context, services, quality, maxSize) {
  const { AssetsService, FilesService } = services;
  const transformation = getTransformation(payload.type, quality, maxSize);
  if (transformation !== undefined) {
    const serviceOptions = { ...context, knex: context.database };
    const assets = new AssetsService(serviceOptions);
    const files = new FilesService(serviceOptions);

    const { stream, stat } = await assets.getAsset(key, transformation);
    if (stat.size < payload.filesize) {
      await sleep(4000);

      // Check for existing thumbnails
      delete payload.width;
      delete payload.height;
      delete payload.size;

      await files.uploadOne(
        stream,
        {
          ...payload,
          type: 'image/avif', // Set the MIME type to AVIF
          optimized: true,
        },
        key,
        { emitEvents: false }
      );
    }
  }
}

function getTransformation(type, quality, maxSize) {
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
      },
    };
  }
  return undefined;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
