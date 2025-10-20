import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "react-hot-toast";
import { Navigation } from "@/components/navigation";

export const metadata: Metadata = {
    title: "Next.js Cloudflare App",
    description:
        "Full-stack Next.js application with Cloudflare Workers, D1 db, R2 storage, and Drizzle ORM.",
};

export const dynamic = "force-dynamic";

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body className="antialiased bg-gray-50 min-h-screen font-sans">
                <Navigation />
                <main>{children}</main>
                <Toaster position="bottom-right" />
            </body>
        </html>
    );
}
