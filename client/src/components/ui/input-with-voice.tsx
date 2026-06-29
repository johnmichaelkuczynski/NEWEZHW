import { forwardRef, useState } from 'react';
import { Input } from './input';
import { VoiceInput } from './voice-input';
import { Button } from './button';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface InputWithVoiceProps extends React.InputHTMLAttributes<HTMLInputElement> {
  onVoiceTranscript?: (text: string) => void;
  showVoiceButton?: boolean;
  showClearButton?: boolean;
}

const InputWithVoice = forwardRef<HTMLInputElement, InputWithVoiceProps>(
  ({ className, onVoiceTranscript, showVoiceButton = true, showClearButton = true, onChange, value, placeholder, ...props }, ref) => {
    const [interimText, setInterimText] = useState('');

    const handleVoiceTranscript = (transcript: string) => {
      setInterimText('');
      if (onVoiceTranscript) {
        onVoiceTranscript(transcript);
      } else if (onChange) {
        const currentValue = String(value || '');
        const newValue = currentValue ? currentValue + ' ' + transcript : transcript;
        const event = { target: { value: newValue } } as React.ChangeEvent<HTMLInputElement>;
        onChange(event);
      }
    };

    const handleInterim = (interim: string) => {
      setInterimText(interim);
    };

    const handleClear = () => {
      setInterimText('');
      if (onChange) {
        const event = { target: { value: '' } } as React.ChangeEvent<HTMLInputElement>;
        onChange(event);
      }
    };

    const hasButtons = showVoiceButton || (showClearButton && value);
    const buttonCount = (showVoiceButton ? 1 : 0) + (showClearButton && value ? 1 : 0);
    const paddingRight = buttonCount === 2 ? "pr-16" : hasButtons ? "pr-10" : "";

    const displayValue = interimText
      ? (String(value || '') + (value ? ' ' : '') + interimText)
      : value;

    return (
      <div className="relative">
        <Input
          ref={ref}
          className={cn(
            paddingRight,
            interimText && 'italic text-slate-400',
            className
          )}
          value={displayValue}
          onChange={onChange}
          placeholder={interimText ? undefined : placeholder}
          {...props}
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
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

InputWithVoice.displayName = "InputWithVoice";

export { InputWithVoice };
