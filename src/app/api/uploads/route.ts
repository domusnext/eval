import { NextRequest, NextResponse } from "next/server";
import { getRequestContext } from "@cloudflare/next-on-pages";

export async function POST(request: NextRequest) {
    const formData = await request.formData();
    const file = formData.get("file");
    const type = formData.get("type");

    if (!(file instanceof File)) {
        return NextResponse.json(
            { error: "Missing file upload" },
            { status: 400 },
        );
    }

    if (type !== "image" && type !== "file") {
        return NextResponse.json(
            { error: "Invalid upload type" },
            { status: 400 },
        );
    }

    const ctx = getRequestContext();
    const bucket = ctx.env.eval_r2_bucket;
    const arrayBuffer = await file.arrayBuffer();

    const extension = file.name.split(".").pop() ?? "";
    const safeExtension = extension ? `.${extension}` : "";
    const key = [
        "uploads",
        type,
        `${Date.now()}-${crypto.randomUUID()}${safeExtension}`,
    ].join("/");

    await bucket.put(key, arrayBuffer, {
        httpMetadata: {
            contentType: file.type || undefined,
            contentDisposition: `inline; filename="${file.name}"`,
        },
    });

    const baseUrl = ctx.env.CLOUDFLARE_R2_URL?.replace(/\/+$/, "") ?? "";
    const url = baseUrl ? `${baseUrl}/${key}` : `/${key}`;

    return NextResponse.json({
        url,
        key,
        size: arrayBuffer.byteLength,
        mimeType: file.type,
        name: file.name,
    });
}
