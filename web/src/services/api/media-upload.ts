import axios from "axios";

import type { AiConfig } from "@/stores/use-config-store";

type UploadMediaType = "image" | "video";
type UploadMediaResponse = {
    success?: boolean;
    url?: string;
    image_url?: string;
    video_url?: string;
    error?: string;
    msg?: string;
};

const MEDIA_UPLOAD_PATH = "/v1/media/upload";
const DEFAULT_MIRRMART_OPENAPI_BASE_URL = "https://www.aimh8.com/agent/openapi/fpbrowser2api";

export async function uploadReferenceMedia(config: AiConfig, file: Blob, type: UploadMediaType, filename?: string, signal?: AbortSignal) {
    const apiKey = config.mirrmartApiKey.trim();
    if (!apiKey) throw new Error("Please configure Mirrmart API Key first");
    const maxBytes = type === "image" ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
    if (file.size > maxBytes) throw new Error(`${type === "image" ? "Image" : "Video"} reference is too large`);

    const form = new FormData();
    form.append("file", file, filename || defaultFilename(type, file.type));
    form.append("type", type);

    const response = await axios.post<UploadMediaResponse>(`${resolveMirrmartOpenApiBaseUrl()}${MEDIA_UPLOAD_PATH}`, form, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
        timeout: 180000,
    });
    const url = response.data.url || response.data.video_url || response.data.image_url;
    if (!url) throw new Error(response.data.error || response.data.msg || "Media upload did not return a URL");
    return url;
}

export function resolveMirrmartOpenApiBaseUrl() {
    const envBase = process.env.NEXT_PUBLIC_MIRRMART_OPENAPI_BASE_URL?.trim();
    if (envBase) return envBase.replace(/\/+$/, "");
    if (typeof window === "undefined") return DEFAULT_MIRRMART_OPENAPI_BASE_URL;
    const hostname = window.location.hostname;
    if (!hostname || hostname === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return DEFAULT_MIRRMART_OPENAPI_BASE_URL;
    const parts = hostname.split(".").filter(Boolean);
    const rootHost = parts.length >= 3 ? parts.slice(1).join(".") : hostname;
    return `https://www.${rootHost}/agent/openapi/fpbrowser2api`;
}

function defaultFilename(type: UploadMediaType, mimeType: string) {
    const ext = mimeTypeToExt(mimeType) || (type === "image" ? "png" : "mp4");
    return `reference-${Date.now()}.${ext}`;
}

function mimeTypeToExt(mimeType: string) {
    const value = mimeType.toLowerCase();
    if (value === "image/jpeg" || value === "image/jpg") return "jpg";
    if (value === "image/png") return "png";
    if (value === "image/webp") return "webp";
    if (value === "image/gif") return "gif";
    if (value === "video/mp4") return "mp4";
    if (value === "video/webm") return "webm";
    if (value === "video/quicktime") return "mov";
    return "";
}
