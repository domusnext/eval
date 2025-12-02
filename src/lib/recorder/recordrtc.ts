'use client';

import RecordRTC, { StereoAudioRecorder } from 'recordrtc';

export const AUDIO_CONFIG = {
  SAMPLE_RATE: 16000,
  FORMAT: 'audio/wav',
  BITS_PER_SAMPLE: 16,
  CHANNELS: 1
} as const;

const PERMISSION_DENIED_ERROR = new Error('Permission denied');
export async function getAudioStream(callback: (blob: Blob) => void): Promise<{ recorder: RecordRTC, stream: MediaStream }> {
  return new Promise(async (resolve, reject) => {
    try {
      const permission = await navigator.permissions.query({ name: 'microphone' })
      if (permission.state === 'denied') {
        reject(PERMISSION_DENIED_ERROR);
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new RecordRTC(stream, {
        type: 'audio',
        mimeType: 'audio/webm;codecs=pcm',  // AWS Transcribe 支持 wav/pcm
        recorderType: StereoAudioRecorder,
        desiredSampRate: 16000, // AWS 推荐 16kHz
        numberOfAudioChannels: 1, // 单声道
        timeSlice: 300, // 每秒回调一次
        ondataavailable: (blob) => {
          callback(blob);
        }
      });
      resolve({ recorder, stream });
      recorder.startRecording();
    } catch (error) {
      reject(error);
    }
  },
  );
}