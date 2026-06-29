import { useState, useCallback, useRef, useEffect } from 'react';
import { Mic, MicOff, Volume2 } from 'lucide-react';
import { Button } from './button';
import { cn } from '@/lib/utils';

interface VoiceInputProps {
  onTranscript: (text: string) => void;
  onInterim?: (text: string) => void;
  isActive?: boolean;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

const SAMPLE_RATE = 16000;

function float32ToInt16Base64(float32Array: Float32Array): string {
  const int16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    int16[i] = Math.max(-32768, Math.min(32767, float32Array[i] * 32768));
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function VoiceInput({ onTranscript, onInterim, isActive = false, className, size = 'md' }: VoiceInputProps) {
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [interimText, setInterimText] = useState('');

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const cleanup = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ terminate_session: true }));
        wsRef.current.close();
      }
      wsRef.current = null;
    }
    setInterimText('');
    setIsListening(false);
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  const startListening = useCallback(async () => {
    setError(null);
    try {
      // 1. Get temporary AssemblyAI token from our backend
      const tokenResp = await fetch('/api/assemblyai/token', { method: 'POST' });
      if (!tokenResp.ok) throw new Error('Failed to get voice token');
      const { token } = await tokenResp.json();

      // 2. Open mic
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // 3. Create AudioContext resampled to 16kHz
      audioContextRef.current = new AudioContext({ sampleRate: SAMPLE_RATE });
      sourceRef.current = audioContextRef.current.createMediaStreamSource(stream);

      // 4. ScriptProcessor to capture raw PCM chunks
      processorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);
      sourceRef.current.connect(processorRef.current);
      processorRef.current.connect(audioContextRef.current.destination);

      // 5. Connect AssemblyAI WebSocket
      const ws = new WebSocket(
        `wss://api.assemblyai.com/v2/realtime/ws?sample_rate=${SAMPLE_RATE}&token=${encodeURIComponent(token)}`
      );
      wsRef.current = ws;

      ws.onopen = () => {
        setIsListening(true);
        // Wire audio processor now that WS is open
        if (processorRef.current) {
          processorRef.current.onaudioprocess = (e) => {
            if (ws.readyState === WebSocket.OPEN) {
              const pcm = e.inputBuffer.getChannelData(0);
              const b64 = float32ToInt16Base64(pcm);
              ws.send(JSON.stringify({ audio_data: b64 }));
            }
          };
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.message_type === 'PartialTranscript' && msg.text) {
            setInterimText(msg.text);
            onInterim?.(msg.text);
          } else if (msg.message_type === 'FinalTranscript' && msg.text) {
            setInterimText('');
            onInterim?.('');
            onTranscript(msg.text);
          } else if (msg.message_type === 'SessionTerminated') {
            cleanup();
          } else if (msg.error) {
            setError(msg.error);
            cleanup();
          }
        } catch {}
      };

      ws.onerror = () => {
        setError('Voice connection error');
        cleanup();
      };

      ws.onclose = () => {
        setIsListening(false);
        setInterimText('');
      };

    } catch (err: any) {
      setError(err.message || 'Microphone error');
      cleanup();
    }
  }, [onTranscript, onInterim, cleanup]);

  const stopListening = useCallback(() => {
    cleanup();
  }, [cleanup]);

  const handleToggle = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening]);

  const sizeClasses = { sm: 'h-6 w-6', md: 'h-8 w-8', lg: 'h-10 w-10' };
  const iconSizes = { sm: 'w-3 h-3', md: 'w-4 h-4', lg: 'w-5 h-5' };

  const title = error
    ? error
    : isListening
    ? interimText
      ? `Hearing: "${interimText.substring(0, 40)}..."`
      : 'Listening… click to stop'
    : 'Click to dictate (powered by AssemblyAI)';

  return (
    <Button
      type="button"
      variant={isListening ? 'default' : 'outline'}
      size="sm"
      className={cn(
        sizeClasses[size],
        'p-1 transition-all duration-200',
        isListening && 'bg-red-500 hover:bg-red-600 text-white animate-pulse',
        error && 'border-red-300 bg-red-50',
        className
      )}
      onClick={handleToggle}
      title={title}
    >
      {isListening ? (
        <Volume2 className={cn(iconSizes[size], 'animate-pulse')} />
      ) : error ? (
        <MicOff className={cn(iconSizes[size], 'text-red-500')} />
      ) : (
        <Mic className={iconSizes[size]} />
      )}
    </Button>
  );
}
