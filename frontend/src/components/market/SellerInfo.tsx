import { Store } from 'lucide-react';
import type { Seller } from '../../api';
import { cn } from '../../lib/utils';

// Who sells the portfolio: the trader, not the platform (Decreto 7.962/2013, art. 2º). Next to the price on the
// portfolio's page and in the order of the checkout. Until the trader fills the seller in, only the public name
export default function SellerInfo({ seller, fallbackName, className }: {
    seller?: Seller | null; fallbackName: string; className?: string;
}) {
    return (
        <div className={cn('space-y-1 text-xs text-muted-foreground', className)}>
            <p className="flex items-center gap-1.5 text-sm">
                <Store className="size-3.5 shrink-0" />
                <span>Vendido por <strong className="font-medium text-foreground">{seller?.name ?? fallbackName}</strong></span>
            </p>
            {seller && (
                <>
                    <p><a href={`mailto:${seller.email}`} className="hover:text-foreground">{seller.email}</a></p>
                    {/*seller.credential && (seller.credential_verified
                        ? <p className="flex items-start gap-1 text-foreground"><BadgeCheck className="mt-px size-3.5 shrink-0 text-success" />
                            <span>Analista credenciado na APIMEC: {seller.credential}{seller.credential_checked_at && <span className="text-muted-foreground">, conferido pela Trademetric em {formatDate(parseUtc(seller.credential_checked_at))}</span>}</span></p>
                        : <p>Credenciamento informado pelo trader, ainda não conferido: {seller.credential}</p>)*/}
                </>
            )}
            <br /><p>A Trademetric fornece a plataforma.</p>
        </div>
    );
}
