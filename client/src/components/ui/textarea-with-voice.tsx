import { forwardRef, useState } from 'react';
import { Textarea } from './textarea';
import { VoiceInput } from './voice-input';
import { Button } from './button';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface TextareaWithVoiceProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  onVoiceTranscript?: (text: string) => void;
  showVoiceButton?: boolean;
  showClearButton?: boolean;
}

const TextareaWithVoice = forwardRef<HTMLTextAreaElement, TextareaWithVoiceProps>(
  ({ className, onVoiceTranscript, showVoiceButton = true, showClearButton = true, onChange, value, placeholder, ...props }, ref) => {
    const [interimText, setInterimText] = useState('');

    const handleVoiceTranscript = (transcript: string) => {
      setInterimText('');
      if (onVoiceTranscript) {
        onVoiceTranscript(transcript);
      } else if (onChange) {
        const currentValue = String(value || '');
        const newValue = currentValue ? currentValue + ' ' + transcript : transcript;
        const event = { target: { value: newValue } } as React.ChangeEvent<HTMLTextAreaElement>;
        onChange(event);
      }
    };

    const handleInterim = (interim: string) => {
      setInterimText(interim);
    };

    const handleClear = () => {
      setInterimText('');
      if (onChange) {
        const event = { target: { value: '' } } as React.ChangeEvent<HTMLTextAreaElement>;
        onChange(event);
      }
    };

    const hasButtons = showVoiceButton || (showClearButton && value);
    const buttonCount = (showVoiceButton ? 1 : 0) + (showClearButton && value ? 1 : 0);
    const paddingRight = buttonCount === 2 ? "pr-20" : hasButtons ? "pr-12" : "";

    const displayValue = interimText
      ? (String(value || '') + (value ? ' ' : '') + interimText)
      : value;

    const displayPlaceholder = interimText ? undefined : placeholder;

    return (
      <div className="relative">
        <Textarea
          ref={ref}
          className={cn(
            paddingRight,
            interimText && 'italic text-slate-400',
            className
          )}
          value={displayValue}
          onChange={onChange}
          placeholder={displayPlaceholder}
          {...props}
        />
        <div className="absolute right-2 top-2 flex items-center gap-1">
          {showClearButton && value && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 hover:bg-gray-100"
              onClick={handleClear}
              title="Clear field"
            >
              <X className="w-3 h-3 text-gray-400" />
            </Button>
          )}
          {showVoiceButton && (
            <VoiceInput
              onTranscript={handleVoiceTranscript}
              onInterim={handleInterim}
              size="sm"
            />
          )}
        </div>
      </div>
    );
  }
);

TextareaWithVoice.displayName = "TextareaWithVoice";

export { TextareaWithVoice };
