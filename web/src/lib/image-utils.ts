import type { ReferenceImage } from "@/types/image";

export function formatBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return "";
    }
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatDuration(ms: number) {
    const value = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(value / 60);
    const seconds = value % 60;
    return minutes ? `${minutes}分${String(seconds).padStart(2, "0")}秒` : `${seconds}秒`;
}

export function getDataUrlByteSize(dataUrl: string) {
    const base64 = dataUrl.split(",", 2)[1];
    if (!base64) {
        return 0;
    }
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

const DEFAULT_MAX_IMAGE_BYTES = 500 * 1024;
const MIN_COMPRESS_QUALITY = 0.45;
const COMPRESS_QUALITY_STEP = 0.08;
const COMPRESS_SCALE_STEP = 0.86;

export async function compressDataUrlForApi(dataUrl: string, maxBytes = DEFAULT_MAX_IMAGE_BYTES) {
    if (getDataUrlByteSize(dataUrl) <= maxBytes) return dataUrl;

    const image = await loadImage(dataUrl);
    let width = image.naturalWidth || image.width || 1024;
    let height = image.naturalHeight || image.height || 1024;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("鍘嬬缉鍥剧墖澶辫触");

    for (let scaleAttempt = 0; scaleAttempt < 10; scaleAttempt += 1) {
        canvas.width = Math.max(1, Math.round(width));
        canvas.height = Math.max(1, Math.round(height));
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);

        for (let quality = 0.9; quality >= MIN_COMPRESS_QUALITY; quality -= COMPRESS_QUALITY_STEP) {
            const compressed = canvas.toDataURL("image/jpeg", quality);
            if (getDataUrlByteSize(compressed) <= maxBytes) return compressed;
        }

        width *= COMPRESS_SCALE_STEP;
        height *= COMPRESS_SCALE_STEP;
    }

    const finalDataUrl = canvas.toDataURL("image/jpeg", MIN_COMPRESS_QUALITY);
    if (getDataUrlByteSize(finalDataUrl) > maxBytes) throw new Error("鍥剧墖鍘嬬缉鍚庝粛瓒呰繃 500KB锛岃鎹㈢敤鏇村皬鐨勫弬鑰冨浘");
    return finalDataUrl;
}

function loadImage(dataUrl: string) {
    return new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("璇诲彇鍥剧墖澶辫触"));
        image.src = dataUrl;
    });
}

export function readFileAsDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片失败"));
        reader.readAsDataURL(file);
    });
}

export function readImageMeta(dataUrl: string) {
    return new Promise<{ width: number; height: number; mimeType: string }>((resolve) => {
        const image = new Image();
        const done = () => resolve({ width: image.naturalWidth || 1024, height: image.naturalHeight || 1024, mimeType: dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png" });
        image.onload = done;
        image.onerror = done;
        setTimeout(done, 3000);
        image.src = dataUrl;
    });
}

export function dataUrlToFile(image: ReferenceImage) {
    const [header, content] = image.dataUrl.split(",", 2);
    const mimeType = header.match(/data:(.*?);base64/)?.[1] || image.type || "image/png";
    const binary = atob(content || "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], image.name || "reference.png", { type: mimeType });
}
