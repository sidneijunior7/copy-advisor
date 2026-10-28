import { useEffect, useState } from 'react';
import { ArrowLeft, Check, CheckCircle2, Cloud, Download, KeyRound, Loader2, Monitor, PartyPopper } from 'lucide-react';
import { toast } from 'sonner';
import api, { type ClientLicense, type EaReleases, type MyLicenses } from '../../api';
import CopyField from '../CopyField';
import OneTimeKey from '../OneTimeKey';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import ConnectAccount from './ConnectAccount';
import HostingForm from './HostingForm';
import { HostingBillingBody } from './HostingBilling';
import { SIGNALS_URL, downloadSlave } from '../../lib/ea';
import { HOSTING_STATES } from '../../lib/labels';
import { formatMoney, periodLabel } from '../../lib/money';
import { apiError, cn } from '../../lib/utils';

type Mode = 'cloud' | 'computer';

const STEPS = ['Sua conta', 'Como copiar', 'Pronto'];

function Stepper({ current }: { current: number }) {
    return (
        <ol className="flex items-center gap-2" aria-label="Etapas da ativação">
            {STEPS.map((label, i) => {
                const done = i < current;
                const active = i === current;
                return (
                    <li key={label} className="flex flex-1 items-center gap-2" aria-current={active ? 'step' : undefined}>
                        <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
                            done && 'border-success bg-success text-success-foreground',
                            active && 'border-primary bg-primary text-primary-foreground',
                            !done && !active && 'border-border text-muted-foreground')}>
                            {done ? <Check className="size-3.5" /> : i + 1}
                        </span>
                        <span className={cn('truncate text-xs font-medium sm:text-sm', !active && 'text-muted-foreground')}>{label}</span>
                        {i < STEPS.length - 1 && <span className={cn('h-px flex-1', done ? 'bg-success' : 'bg-border')} />}
                    </li>
                );
            })}
        </ol>
    );
}

// One of the two ways of copying, as a big button that fits a thumb
function Choice({ icon, title, tag, price, points, onClick, recommended = false }: {
    icon: React.ReactNode; title: string; tag?: string; price: string; points: string[]; onClick: () => void; recommended?: boolean;
}) {
    return (
        <button type="button" onClick={onClick}
            className={cn('relative flex w-full flex-col gap-3 rounded-xl border-2 p-4 text-left transition-colors active:scale-[0.99] sm:p-5',
                recommended ? 'border-primary bg-primary/5 hover:bg-primary/10' : 'border-border hover:border-primary/40 hover:bg-muted/40')}>
            <div className="flex items-start justify-between gap-2">
                <span className={cn('rounded-lg p-2 [&_svg]:size-5', recommended ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground')}>{icon}</span>
                {tag && <Badge variant={recommended ? 'primary' : 'muted'}>{tag}</Badge>}
            </div>
            <div>
                <p className="text-base font-semibold">{title}</p>
                <p className="text-sm font-semibold text-primary">{price}</p>
            </div>
            <ul className="space-y-1 text-sm text-muted-foreground">
                {points.map(p => <li key={p} className="flex items-start gap-2"><Check className="mt-0.5 size-3.5 shrink-0 text-success" /> {p}</li>)}
            </ul>
        </button>
    );
}

// The EA on the client's own computer: download, key, where to paste it, then waiting for it to connect
function ComputerSetup({ license, onChanged }: { license: ClientLicense; onChanged: () => void }) {
    const [releases, setReleases] = useState<EaReleases | null>(null);
    const [key, setKey] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        api.get<EaReleases>('/ea/releases').then(res => setReleases(res.data)).catch(e => console.error(e));
    }, []);

    const newKey = async () => {
        setBusy(true);
        try {
            const res = await api.post<{ license_key: string }>(`/me/licenses/${license.id}/key`);
            setKey(res.data.license_key);
            onChanged();
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível gerar a chave.'));
        } finally {
            setBusy(false);
        }
    };

    const step = 'flex gap-3';
    const num = 'flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold';

    return (
        <ol className="space-y-5 text-sm">
            <li className={step}>
                <span className={num}>1</span>
                <div className="min-w-0 flex-1 space-y-2">
                    <p className="font-medium">Baixe o EA no computador que tem o MetaTrader 5</p>
                    <Button variant="outline" className="w-full sm:w-auto" disabled={!releases?.slave}
                        onClick={async () => { setBusy(true); await downloadSlave(releases?.slave); setBusy(false); }}>
                        <Download /> Baixar o EA{releases?.slave ? ` ${releases.slave.version}` : ''}
                    </Button>
                    <p className="text-xs text-muted-foreground">No MetaTrader: <strong>Arquivo › Abrir pasta de dados</strong>, cole o arquivo em <code>MQL5\Experts</code> e clique em Atualizar no Navegador.</p>
                </div>
            </li>
            <li className={step}>
                <span className={num}>2</span>
                <div className="min-w-0 flex-1 space-y-2">
                    <p className="font-medium">Libere o endereço da cópia</p>
                    <p className="text-xs text-muted-foreground">Em <strong>Ferramentas › Opções › Expert Advisors</strong>, marque <strong>Permitir negociação algorítmica</strong> e <strong>Permitir WebRequest</strong>, e adicione este endereço:</p>
                    <CopyField value={SIGNALS_URL} label="URL" />
                </div>
            </li>
            <li className={step}>
                <span className={num}>3</span>
                <div className="min-w-0 flex-1 space-y-2">
                    <p className="font-medium">Gere sua chave e cole no EA</p>
                    {key ? (
                        <OneTimeKey title="Sua chave" value={key} label="Chave" onClose={() => setKey(null)}>
                            Arraste o EA para qualquer gráfico da conta {license.mt5_login}. Em <strong>Entradas</strong>, cole a chave em <em>License key</em>.
                            Ela aparece só agora: copie antes de fechar.
                        </OneTimeKey>
                    ) : (
                        <Button className="w-full sm:w-auto" loading={busy} onClick={newKey}>
                            {!busy && <KeyRound />} {license.has_key ? 'Gerar uma nova chave' : 'Gerar minha chave'}
                        </Button>
                    )}
                </div>
            </li>
            <li className={step}>
                <span className={num}>4</span>
                <div className="min-w-0 flex-1">
                    {license.connection ? (
                        <p className="flex items-center gap-2 font-medium text-success"><CheckCircle2 className="size-4" /> EA conectado</p>
                    ) : (
                        <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Esperando o EA conectar…</p>
                    )}
                </div>
            </li>
        </ol>
    );
}

// The setup between paying and copying, one step at a time: the MT5 account, then the cloud or the computer, then
// the copy running. The cloud is the easy way, so it comes first and recommended
export default function ActivationWizard({ license, data, onChanged, onDone }: {
    license: ClientLicense; data: MyLicenses; onChanged: () => void; onDone: () => void;
}) {
    const [mode, setMode] = useState<Mode | null>(license.hosting ? 'cloud' : license.has_key ? 'computer' : null);
    const [busy, setBusy] = useState(false);
    const cloud = data.hosting_available && (data.hosting_room || license.hosting != null);  // No room: the computer only
    const price = data.hosting_price;
    const hosted = license.hosting;
    const copying = license.connection != null || hosted?.state === 'running';
    const current = license.mt5_login == null ? 0 : copying ? 2 : 1;

    // A hosting never paid: its server and password go, and the two ways are back on screen
    const otherWay = async () => {
        setBusy(true);
        try {
            await api.delete(`/me/licenses/${license.id}/hosting`);
            setMode(null);
            onChanged();
        } catch (e) {
            console.error(e);
            toast.error(apiError(e, 'Não foi possível voltar.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className="panel space-y-6 p-4 sm:p-6">
            <div className="space-y-1">
                <h2 className="text-lg font-semibold sm:text-xl">
                    {current === 0 ? 'Vamos ativar sua cópia' : current === 1 ? 'Como você quer copiar?' : 'Tudo pronto!'}
                </h2>
                <p className="text-sm text-muted-foreground">
                    {current === 0 ? 'São 2 passos rápidos, e depois as operações do gestor chegam sozinhas na sua conta.'
                        : current === 1 ? 'Escolha onde o MetaTrader vai rodar. Dá para mudar depois.'
                            : 'Sua conta está conectada e recebe as próximas operações do gestor.'}
                </p>
            </div>
            <Stepper current={current} />

            {current === 0 && <ConnectAccount license={license} onDone={onChanged} />}

            {current === 1 && mode === null && (
                <div className={cn('grid grid-cols-1 gap-3', cloud && 'md:grid-cols-2')}>
                    {cloud && (
                        <Choice
                            recommended
                            icon={<Cloud />}
                            title="Automático na nuvem"
                            tag="Recomendado"
                            price={price ? `${formatMoney(price.price, price.currency)} por ${periodLabel(price.days)}` : 'Incluído'}
                            points={['Nada para instalar', 'Funciona com o computador desligado', 'Pronto em 2 minutos']}
                            onClick={() => setMode('cloud')}
                        />
                    )}
                    <Choice
                        icon={<Monitor />}
                        title="No meu computador"
                        tag={cloud ? 'Avançado' : undefined}
                        price="Grátis"
                        points={['Instale o EA no seu MetaTrader 5', 'O MetaTrader precisa ficar aberto durante o pregão']}
                        onClick={() => setMode('computer')}
                    />
                </div>
            )}

            {current === 1 && mode === 'cloud' && (
                hosted ? (
                    <div className="space-y-4 rounded-lg border border-border p-4">
                        {hosted.billing.paid ? (
                            <p className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Loader2 className="size-4 animate-spin" /> {HOSTING_STATES[hosted.state]?.label ?? hosted.state}: ligando o MetaTrader da sua conta…
                            </p>
                        ) : (
                            <>
                                <HostingBillingBody licenseId={license.id} billing={hosted.billing} price={price} onChanged={onChanged} />
                                <Button variant="ghost" size="sm" loading={busy} onClick={otherWay}>{!busy && <ArrowLeft />} Escolher outro jeito</Button>
                            </>
                        )}
                    </div>
                ) : (
                    <div className="space-y-4">
                        <p className="text-sm text-muted-foreground">
                            Informe o acesso da conta <strong className="text-foreground">{license.mt5_login}</strong>, o mesmo que você usa para entrar no MetaTrader.
                        </p>
                        <HostingForm license={license} servers={data.servers} price={price} onCancel={() => setMode(null)} cancelLabel="Voltar" onSaved={onChanged} />
                    </div>
                )
            )}

            {current === 1 && mode === 'computer' && (
                <div className="space-y-4">
                    <ComputerSetup license={license} onChanged={onChanged} />
                    {!license.connection && (
                        <Button variant="ghost" size="sm" onClick={() => setMode(null)}><ArrowLeft /> Escolher outro jeito</Button>
                    )}
                </div>
            )}

            {current === 2 && (
                <div className="space-y-4 text-center sm:text-left">
                    <div className="flex flex-col items-center gap-3 rounded-lg border border-success/30 bg-success/5 p-4 sm:flex-row">
                        <PartyPopper className="size-8 shrink-0 text-success" />
                        <p className="text-sm">
                            Na próxima operação do gestor, a cópia aparece na aba <strong>Cópias</strong> e o resultado no seu painel.
                            Se quiser parar, é só desligar a chave no topo da página.
                        </p>
                    </div>
                    <Button className="w-full sm:w-auto" onClick={onDone}>Ver minha cópia</Button>
                </div>
            )}
        </section>
    );
}
