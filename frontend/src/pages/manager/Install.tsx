
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Download, PackageX, RadioTower, Users } from 'lucide-react';
import { toast } from 'sonner';
import api, { type EaKind, type EaRelease, type EaReleases } from '../../api';
import Card from '../../components/Card';
import CopyField from '../../components/CopyField';
import EmptyState from '../../components/EmptyState';
import PageHeader from '../../components/PageHeader';
import { Button } from '../../components/ui/Button';
import { formatDateTime } from '../../lib/utils';

const SIGNALS_URL = 'https://signals.trademetric.com.br';

const linkClass = 'font-medium text-primary underline-offset-4 hover:underline';

// Steps every terminal goes through, Master or Slave
const commonSteps: ReactNode[] = [
    <>No MetaTrader 5, abra <strong>Arquivo › Abrir pasta de dados</strong> e copie o arquivo para <code>MQL5\Experts</code>. Depois, em <strong>Navegador</strong>, clique em Atualizar.</>,
    <>Em <strong>Ferramentas › Opções › Expert Advisors</strong>, marque <strong>Permitir WebRequest para as URLs listadas</strong> e adicione <code>{SIGNALS_URL}</code>, sem porta. <strong>Permitir importação de DLL</strong> pode ficar desligado.</>,
];

type EaInfo = { title: string; description: string; icon: ReactNode; steps: ReactNode[] };

const EAS: Record<EaKind, EaInfo> = {
    master: {
        title: 'EA Master',
        description: 'Roda na conta que opera as estratégias e envia cada posição ao hub.',
        icon: <RadioTower />,
        steps: [
            ...commonSteps,
            <>Arraste o EA para um gráfico qualquer da conta. Em <strong>Entradas</strong>, cole em <em>Master key</em> uma chave criada em{' '}
                <Link to="/manager/strategies" className={linkClass}>Estratégias › Chaves do Master</Link>. Use uma chave por Master/VPS.</>,
            <>O gráfico mostra <strong>Hub: conectado</strong>, e o terminal aparece em{' '}
                <Link to="/manager/connections" className={linkClass}>Conexões</Link>.</>,
        ],
    },
    slave: {
        title: 'EA Slave',
        description: 'Roda na conta do cliente e copia as posições do portfólio da licença dele.',
        icon: <Users />,
        steps: [
            <>Envie o arquivo ao cliente com a chave da licença, gerada em{' '}
                <Link to="/manager/clients" className={linkClass}>Clientes</Link>. A chave aparece uma vez só.</>,
            ...commonSteps,
            <>Arraste o EA para um gráfico qualquer da conta da licença. Em <strong>Entradas</strong>, cole a chave em <em>License key</em>.</>,
            <>O gráfico mostra o portfólio e o limite de lotes, e o terminal aparece em{' '}
                <Link to="/manager/connections" className={linkClass}>Conexões</Link>.</>,
        ],
    },
};

const formatSize = (bytes: number) => `${Math.round(bytes / 1024).toLocaleString('pt-BR')} KB`;

export default function Install() {
    const [releases, setReleases] = useState<EaReleases | null>(null);
    const [failed, setFailed] = useState(false);
    const [downloading, setDownloading] = useState<EaKind | null>(null);

    useEffect(() => {
        api.get<EaReleases>('/ea/releases')
            .then(res => setReleases(res.data))
            .catch(e => {
                console.error(e);
                setFailed(true);
            });
    }, []);

    // The file needs the session token, so it comes through the API client rather than a plain link
    const download = async (kind: EaKind, release: EaRelease) => {
        setDownloading(kind);
        try {
            const res = await api.get<Blob>(`/ea/releases/${kind}`, { responseType: 'blob' });
            const url = URL.createObjectURL(res.data);
            const a = document.createElement('a');
            a.href = url;
            a.download = release.file;
            a.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (e) {
            console.error(e);
            toast.error('Não foi possível baixar o arquivo.');
        } finally {
            setDownloading(null);
        }
    };

    const available = releases ? (Object.keys(EAS) as EaKind[]).filter(kind => releases[kind]) : [];

    return (
        <div className="space-y-6">
            <PageHeader
                title="Instalação"
                description="Baixe a versão atual de cada EA e siga os passos no MetaTrader 5."
                icon={<Download />}
            />

            {releases === null ? (
                <p className="text-sm text-muted-foreground">{failed ? 'Não foi possível consultar os EAs.' : 'Carregando...'}</p>
            ) : available.length === 0 ? (
                <div className="panel">
                    <EmptyState
                        icon={<PackageX />}
                        title="Nenhum EA publicado"
                        description="O servidor ainda não tem os arquivos compilados."
                    />
                </div>
            ) : (
                <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
                    {available.map(kind => {
                        const ea = EAS[kind];
                        const release = releases[kind]!;
                        return (
                            <Card key={kind} title={ea.title} description={ea.description} icon={ea.icon}>
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <div className="text-sm">
                                        <p className="font-semibold">Versão {release.version}</p>
                                        <p className="text-muted-foreground">
                                            {formatSize(release.size)} · compilado em {formatDateTime(release.built_at)}
                                        </p>
                                    </div>
                                    <Button onClick={() => download(kind, release)} loading={downloading === kind}>
                                        {downloading !== kind && <Download />} Baixar
                                    </Button>
                                </div>

                                <ol className="mt-5 list-decimal space-y-2 border-t border-border pl-5 pt-4 text-sm leading-relaxed text-muted-foreground marker:text-foreground [&_code]:rounded [&_code]:bg-secondary [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_code]:text-foreground [&_strong]:text-foreground">
                                    {ea.steps.map((step, i) => <li key={i}>{step}</li>)}
                                </ol>
                                <p className="mt-4 text-xs text-muted-foreground">
                                    Para atualizar, troque o arquivo e recoloque o EA no gráfico: as cópias abertas continuam vinculadas.
                                </p>

                                <div className="mt-4">
                                    <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">SHA-256</p>
                                    <CopyField value={release.sha256} label="Soma SHA-256" />
                                </div>
                            </Card>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
