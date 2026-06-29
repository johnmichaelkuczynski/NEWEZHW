import { useState, useCallback, useRef } from 'react';
import type { GlobalSkeleton, StitchValidation } from '@shared/schema';

export interface StreamEvent {
  type: 'skeleton' | 'chunk' | 'pause_complete' | 'stitch' | 'repair' | 'complete' | 'error' | 'status';
  content?: any;
  index?: number;
  nextChunk?: number;
  chunkIndex?: number;
  message?: string;
}

export interface CoherentStreamState {
  isStreaming: boolean;
  skeleton: GlobalSkeleton | null;
  chunks: string[];
  currentChunk: number;
  totalChunks: number;
  stitchResult: StitchValidation | null;
  statusMessage: string;
  error: string | null;
  accumulatedContent: string;
}

export function useCoherentStream() {
  const [state, setState] = useState<CoherentStreamState>({
    isStreaming: false,
    skeleton: null,
    chunks: [],
    currentChunk: 0,
    totalChunks: 0,
    stitchResult: null,
    statusMessage: '',
    error: null,
    accumulatedContent: ''
  });

  const eventSourceRef = useRef<EventSource | null>(null);

  const startStream = useCallback(async (prompt: string, inputText: string, sessionType: string = 'homework') => {
    setState(prev => ({
      ...prev,
      isStreaming: true,
      skeleton: null,
      chunks: [],
      currentChunk: 0,
      totalChunks: 0,
      stitchResult: null,
      statusMessage: 'Starting coherent processing...',
      error: null,
      accumulatedContent: ''
    }));

    try {
      const response = await fetch('/api/coherent-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, inputText, sessionType })
      });

      if (!response.ok) {
        throw new Error('Failed to start coherent stream');
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event: StreamEvent = JSON.parse(line.slice(6));
              handleEvent(event);
            } catch (e) {
              console.error('Failed to parse SSE event:', e);
            }
          }
        }
      }
    } catch (error: any) {
      setState(prev => ({
        ...prev,
        isStreaming: false,
        error: error.message
      }));
    }
  }, []);

  const handleEvent = useCallback((event: StreamEvent) => {
    switch (event.type) {
      case 'status':
        setState(prev => ({ ...prev, statusMessage: event.message || '' }));
        break;

      case 'skeleton':
        setState(prev => ({
          ...prev,
          skeleton: event.content as GlobalSkeleton,
          statusMessage: 'Skeleton generated, processing chunks...'
        }));
        break;

      case 'chunk':
        setState(prev => {
          const newChunks = [...prev.chunks];
          if (event.index !== undefined) {
            newChunks[event.index] = event.content;
          }
          return {
            ...prev,
            chunks: newChunks,
            currentChunk: (event.index || 0) + 1,
            accumulatedContent: newChunks.join('\n\n'),
            statusMessage: `Processed chunk ${(event.index || 0) + 1}`
          };
        });
        break;

      case 'pause_complete':
        setState(prev => ({
          ...prev,
          statusMessage: `Processing chunk ${(event.nextChunk || 0) + 1}...`
        }));
        break;

      case 'stitch':
        setState(prev => ({
          ...prev,
          stitchResult: event.content as StitchValidation,
          statusMessage: 'Coherence check complete'
        }));
        break;

      case 'repair':
        setState(prev => ({
          ...prev,
          statusMessage: `Repaired chunk ${event.chunkIndex}`
        }));
        break;

      case 'complete':
        setState(prev => ({
          ...prev,
          isStreaming: false,
          statusMessage: 'Complete'
        }));
        break;

      case 'error':
        setState(prev => ({
          ...prev,
          isStreaming: false,
          error: event.message || 'Unknown error'
        }));
        break;
    }
  }, []);

  const stopStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setState(prev => ({
      ...prev,
      isStreaming: false,
      statusMessage: 'Stopped'
    }));
  }, []);

  const reset = useCallback(() => {
    stopStream();
    setState({
      isStreaming: false,
      skeleton: null,
      chunks: [],
      currentChunk: 0,
      totalChunks: 0,
      stitchResult: null,
      statusMessage: '',
      error: null,
      accumulatedContent: ''
    });
  }, [stopStream]);

  return {
    ...state,
    startStream,
    stopStream,
    reset
  };
}
