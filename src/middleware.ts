import { NextRequest, NextResponse } from 'next/server';

// 日志工具函数
function logWebSocketRequest(request: NextRequest, stage: 'request' | 'response', additionalInfo?: Record<string, any>) {
    const timestamp = new Date().toISOString();
    const { pathname, search } = request.nextUrl;
    const url = pathname + search;
    
    const isWebSocketUpgrade = 
        request.headers.get('upgrade') === 'websocket' ||
        request.headers.get('connection')?.toLowerCase().includes('upgrade');
    
    const isWebSocketPath = pathname.includes('/ws') || pathname.includes('/websocket');
    
    if (!isWebSocketUpgrade && !isWebSocketPath) {
        return;
    }

    console.log('\n' + '='.repeat(60));
    console.log(`[运行时日志] WebSocket ${stage === 'request' ? '请求' : '响应'} - ${timestamp}`);
    console.log('-'.repeat(60));
    console.log(`阶段: ${stage === 'request' ? '请求开始' : '响应处理'}`);
    console.log(`方法: ${request.method}`);
    console.log(`路径: ${url}`);
    console.log(`完整 URL: ${request.url}`);
    console.log(`来源: ${request.headers.get('origin') || 'N/A'}`);
    console.log(`User-Agent: ${request.headers.get('user-agent') || 'N/A'}`);
    
    if (isWebSocketUpgrade) {
        console.log('\n--- WebSocket 升级头信息 ---');
        console.log(`Upgrade: ${request.headers.get('upgrade') || 'N/A'}`);
        console.log(`Connection: ${request.headers.get('connection') || 'N/A'}`);
        console.log(`Sec-WebSocket-Key: ${request.headers.get('sec-websocket-key') || 'N/A'}`);
        console.log(`Sec-WebSocket-Version: ${request.headers.get('sec-websocket-version') || 'N/A'}`);
        console.log(`Sec-WebSocket-Protocol: ${request.headers.get('sec-websocket-protocol') || 'N/A'}`);
        console.log(`Sec-WebSocket-Extensions: ${request.headers.get('sec-websocket-extensions') || 'N/A'}`);
    }
    
    // 代理目标信息
    if (pathname.startsWith('/api/agent/agent/v1/speech/ws')) {
        console.log('\n--- 代理配置 ---');
        console.log(`源路径: ${pathname}`);
        console.log(`目标地址: https://domus-agent-738222537643.us-central1.run.app/agent/v1/speech/ws`);
    } else if (pathname.startsWith('/api/agent/')) {
        const targetPath = pathname.replace('/api/agent', '');
        console.log('\n--- 代理配置 ---');
        console.log(`源路径: ${pathname}`);
        console.log(`目标地址: http://localhost:8082${targetPath}${search}`);
    }
    
    // 额外信息
    if (additionalInfo) {
        console.log('\n--- 额外信息 ---');
        Object.entries(additionalInfo).forEach(([key, value]) => {
            console.log(`${key}: ${value}`);
        });
    }
    
    console.log('='.repeat(60) + '\n');
}

export function middleware(request: NextRequest) {
    const { pathname, search } = request.nextUrl;
    const startTime = Date.now();
    const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // 记录请求开始
    logWebSocketRequest(request, 'request', {
        '请求ID': requestId,
        '请求时间戳': startTime,
    });

    // 创建响应
    const response = NextResponse.next();
    
    // 添加响应头以便追踪
    response.headers.set('X-Request-ID', requestId);
    response.headers.set('X-Request-Time', startTime.toString());
    
    // 使用 setTimeout 在响应后记录（异步记录，不阻塞响应）
    setTimeout(() => {
        const endTime = Date.now();
        const duration = endTime - startTime;
        
        logWebSocketRequest(request, 'response', {
            '请求ID': requestId,
            '响应时间戳': endTime,
            '处理耗时': `${duration}ms`,
            '状态码': response.status || 'N/A',
        });
    }, 0);

    return response;
}

export const config = {
    matcher: [
        '/api/agent/:path*',
    ],
};

