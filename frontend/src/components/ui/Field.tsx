import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

const control =
    'flex h-10 w-full rounded-md border border-input bg-secondary px-3 py-2 text-sm text-foreground ring-offset-background transition-colors placeholder:text-muted-foreground focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
    icon?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, icon, ...props }, ref) => {
    if (!icon) return <input ref={ref} className={cn(control, className)} {...props} />;
    return (
        <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground [&_svg]:size-4">
                {icon}
            </span>
            <input ref={ref} className={cn(control, 'pl-10', className)} {...props} />
        </div>
    );
});
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(control, 'h-auto min-h-24 resize-y', className)} {...props} />
));
Textarea.displayName = 'Textarea';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
    ({ className, children, ...props }, ref) => (
        <div className="relative">
            <select ref={ref} className={cn(control, 'appearance-none pr-9', className)} {...props}>
                {children}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        </div>
    ),
);
Select.displayName = 'Select';

// A select shown as a square icon button (for phones): the native picker opens over it,
// and a dot marks a filter that is narrowing the list
interface IconSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
    icon: ReactNode;
    label: string;
    active?: boolean;
}

export function IconSelect({ icon, label, active, className, children, ...props }: IconSelectProps) {
    return (
        <div className={cn('relative flex size-10 shrink-0 items-center justify-center rounded-md border border-input bg-secondary text-foreground transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 ring-offset-background [&_svg]:size-4', active && 'border-primary/60 text-primary', className)}>
            {icon}
            {active && <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-primary" />}
            <select aria-label={label} title={label} className="absolute inset-0 cursor-pointer appearance-none opacity-0" {...props}>
                {children}
            </select>
        </div>
    );
}

interface FieldProps {
    label: string;
    htmlFor: string;
    hint?: ReactNode;
    error?: string;
    className?: string;
    children: ReactNode;
}

export function Field({ label, htmlFor, hint, error, className, children }: FieldProps) {
    return (
        <div className={cn('space-y-2', className)}>
            <label htmlFor={htmlFor} className="block text-sm font-medium leading-none text-foreground">
                {label}
            </label>
            {children}
            {error
                ? <p className="text-sm text-destructive">{error}</p>
                : hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
    );
}
