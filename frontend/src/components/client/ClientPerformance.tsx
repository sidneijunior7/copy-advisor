import { useEffect, useState } from 'react';
import api, { type ClientLicense, type MyPerformance } from '../../api';
import PerformanceView from '../PerformanceView';
import { Select } from '../ui/Field';
import { PERIODS } from '../../lib/labels';
import { cn, isOlderVersion } from '../../lib/utils';

// The client's own result next to what the portfolio realized in the same period
export default function ClientPerformance({ license }: { license: ClientLicense }) {
    const [days, setDays] = useState(90);
    const [data, setData] = useState<MyPerformance | null>(null);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);

    const changeDays = (value: number) => {
        setLoading(true);
        setDays(value);
    };

    useEffect(() => {
        let cancelled = false;
        api.get<MyPerformance>(`/me/licenses/${license.id}/performance`, { params: { days } })
            .then(res => { if (!cancelled) { setData(res.data); setFailed(false); } })
            .catch(e => { console.error(e); if (!cancelled) setFailed(true); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [license.id, days]);

    const oldEa = license.connection?.ea_version != null && isOlderVersion(license.connection.ea_version, '4.04');

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-3">
                <Select value={days} onChange={e => changeDays(Number(e.target.value))} className="h-9 w-48" aria-label="Período">
                    {PERIODS.map(p => <option key={p.days} value={p.days}>{p.label}</option>)}
                </Select>
                {oldEa && (
                    <p className="text-xs text-muted-foreground">
                        O EA {license.connection?.ea_version} não informa o resultado em dinheiro: atualize para 4.04 em Instalação.
                    </p>
                )}
            </div>
            {data === null ? (
                <p className="text-sm text-muted-foreground">{failed ? 'Não foi possível carregar o desempenho.' : 'Carregando...'}</p>
            ) : (
                // While a new period loads, the previous one stays on screen, dimmed
                <div className={cn('space-y-8 transition-opacity', loading && 'opacity-60')}>
                    <section className="space-y-3">
                        <h2 className="text-lg font-semibold">Seu resultado</h2>
                        <PerformanceView
                            stats={data.copies}
                            emptyTitle="Nenhuma cópia fechada no período"
                            emptyDescription="O resultado aparece quando as cópias fecham na sua conta. Ele vem do EA 4.04 ou mais novo."
                        />
                    </section>
                    {data.portfolio && (
                        <section className="space-y-3">
                            <h2 className="text-lg font-semibold">O portfólio no mesmo período</h2>
                            <p className="text-sm text-muted-foreground">
                                Na conta do gestor, no tamanho dele. A diferença para o seu resultado vem do tamanho das suas
                                cópias, do limite de lotes, da sua corretora e das operações que não foram copiadas.
                            </p>
                            <PerformanceView
                                stats={data.portfolio}
                                emptyTitle="Nenhuma operação fechada no período"
                                emptyDescription="O desempenho do portfólio aparece quando as operações fecham na conta do gestor."
                            />
                        </section>
                    )}
                </div>
            )}
        </div>
    );
}
