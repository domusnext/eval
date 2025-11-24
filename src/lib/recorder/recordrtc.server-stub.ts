// 服务端空实现：用于在 SSR 阶段替代 `recordrtc`，避免访问浏览器对象

class ServerSideRecorderStub {
    constructor(..._args: any[]) {}
    startRecording(): void {}
    async stopRecording(): Promise<void> {}
    destroy(): void {}
}

// 与浏览器端命名保持一致的占位导出
const StereoAudioRecorder = class {};

export default ServerSideRecorderStub;
export { StereoAudioRecorder };


