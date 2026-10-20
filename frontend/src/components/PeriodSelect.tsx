import { CalendarDays } from 'lucide-react';
import { IconSelect, Select } from './ui/Field';
import { PERIODS } from '../lib/labels';
import { cn } from '../lib/utils';

interface PeriodSelectProps {
    value: number;
    onChange: (days: number) => void;
    periods?: { days: number; label: string }[];
    className?: string;
}

// The period picker: a calendar icon with the period written next to it on phones, the select from sm up
export default function PeriodSelect({ value, onChange, periods = PERIODS, className }: PeriodSelectProps) {
    const options = periods.map(p => <option key={p.days} value={p.days}>{p.label}</option>);
    return (
        <div className={cn('shrink-0', className)}>
            <div className="flex items-center gap-2 sm:hidden">
                <IconSelect icon={<CalendarDays />} label="Período" value={value} onChange={e => onChange(Number(e.target.value))}>
                    {options}
                </IconSelect>
                <span className="text-sm font-medium">{periods.find(p => p.days === value)?.label}</span>
            </div>
            <div className="hidden w-48 sm:block">{/* The chevron sits at the wrapper's edge: the wrapper takes the width */}
                <Select value={value} onChange={e => onChange(Number(e.target.value))} className="h-9" aria-label="Período">
                    {options}
                </Select>
            </div>
        </div>
    );
}
