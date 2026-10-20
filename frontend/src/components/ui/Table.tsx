import { createContext, useContext, type HTMLAttributes, type TdHTMLAttributes, type ThHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

// A stacked table turns each row into a card on phones: the header hides, labeled cells
// sit two by two with the label above the value, and unlabeled cells take the full width
const Stacked = createContext(false);

export function Table({ className, stack = false, ...props }: HTMLAttributes<HTMLTableElement> & { stack?: boolean }) {
    return (
        <Stacked.Provider value={stack}>
            <div className="relative w-full overflow-auto">
                <table className={cn('w-full caption-bottom text-sm', stack && 'max-md:block', className)} {...props} />
            </div>
        </Stacked.Provider>
    );
}

export function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
    const stack = useContext(Stacked);
    return <thead className={cn('[&_tr]:border-b [&_tr:hover]:bg-transparent', stack && 'max-md:hidden', className)} {...props} />;
}

export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
    const stack = useContext(Stacked);
    return <tbody className={cn('[&_tr:last-child]:border-0', stack && 'max-md:block', className)} {...props} />;
}

export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
    const stack = useContext(Stacked);
    return (
        <tr
            className={cn(
                'border-b transition-colors hover:bg-muted/50',
                stack && 'max-md:grid max-md:grid-cols-2 max-md:gap-x-4 max-md:gap-y-3 max-md:px-5 max-md:py-4 max-md:hover:bg-transparent',
                className,
            )}
            {...props}
        />
    );
}

export function TableHead({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
    return (
        <th
            className={cn('h-11 whitespace-nowrap px-4 text-left align-middle text-xs font-medium uppercase tracking-wider text-muted-foreground', className)}
            {...props}
        />
    );
}

const stackedCell = 'max-md:block max-md:empty:hidden max-md:min-w-0 max-md:whitespace-normal max-md:p-0 max-md:text-left';
const stackedLabel =
    'max-md:before:mb-0.5 max-md:before:block max-md:before:font-sans max-md:before:text-xs max-md:before:font-normal max-md:before:text-muted-foreground max-md:before:content-[attr(data-label)]';

export function TableCell({ className, label, ...props }: TdHTMLAttributes<HTMLTableCellElement> & { label?: string }) {
    const stack = useContext(Stacked);
    return (
        <td
            data-label={label}
            className={cn(
                'whitespace-nowrap px-4 py-3 align-middle',
                stack && stackedCell,
                stack && (label ? stackedLabel : 'max-md:col-span-2'),
                className,
            )}
            {...props}
        />
    );
}
