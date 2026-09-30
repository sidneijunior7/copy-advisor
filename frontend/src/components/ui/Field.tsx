import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
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
