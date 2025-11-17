/**
 * 压缩工具模块
 * 使用 gzip 压缩 evaluation response 以减少数据库存储大小
 */

import { gzipSync, gunzipSync } from "zlib";

/**
 * 压缩文本数据
 * @param text - 原始文本
 * @returns base64 编码的 gzip 压缩数据
 */
export function compressText(text: string): string {
    try {
        const buffer = Buffer.from(text, "utf-8");
        const compressed = gzipSync(buffer, { level: 9 }); // 最高压缩级别
        const base64 = compressed.toString("base64");

        console.log(
            `[Compression] ${buffer.length} bytes → ${base64.length} bytes (${Math.round((base64.length / buffer.length) * 100)}%)`,
        );

        return base64;
    } catch (error) {
        console.error("[Compression] Failed to compress:", error);
        throw new Error(
            `Compression failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/**
 * 解压缩文本数据
 * @param compressed - base64 编码的 gzip 压缩数据
 * @returns 原始文本
 */
export function decompressText(compressed: string): string {
    try {
        const buffer = Buffer.from(compressed, "base64");
        const decompressed = gunzipSync(buffer);
        const text = decompressed.toString("utf-8");

        console.log(
            `[Decompression] ${compressed.length} bytes → ${text.length} bytes`,
        );

        return text;
    } catch (error) {
        console.error("[Decompression] Failed to decompress:", error);
        throw new Error(
            `Decompression failed: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
}

/**
 * 检测字符串是否为压缩数据
 * 通过检查 gzip 魔数（magic number）来判断
 * @param text - 待检测的字符串
 * @returns true 表示是压缩数据
 */
export function isCompressed(text: string): boolean {
    if (!text || text.length < 4) {
        return false;
    }

    try {
        // 尝试解析前几个字符为 base64
        const buffer = Buffer.from(text.substring(0, 8), "base64");

        // gzip 的魔数是 0x1f 0x8b
        return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
    } catch {
        // 如果不是有效的 base64，说明不是压缩数据
        return false;
    }
}
