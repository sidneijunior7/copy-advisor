import { COMPANY } from '../lib/company';
import { cn } from '../lib/utils';

// The company behind the site, in every footer of the public pages and of the checkout
export default function CompanyLine({ className }: { className?: string }) {
    return (
        <p className={cn('text-xs text-muted-foreground', className)}>
            {COMPANY.brand} é operado por {COMPANY.legalName}, CNPJ {COMPANY.cnpj}.{' '}
            <a href={`mailto:${COMPANY.email}`} className="hover:text-foreground">{COMPANY.email}</a>
        </p>
    );
}
