import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Server, Users } from 'lucide-react';
import { toast } from 'sonner';
import api, { type EaReleases } from '../../api';
import Card from '../../components/Card';
import PageHeader from '../../components/PageHeader';
import { Button } from '../../components/ui/Button';

const SIGNALS_URL = 'https://signals.trademetric.com.br';
const linkClass = 'font-medium text-primary underline-offset-4 hover:underline';

// The Slave for a client who runs MetaTrader on their own computer
export default function ClientInstall() {
    const [releases, setReleases] = useState<EaReleases | null>(null);
    const [downloading, setDownloading] = useState(false);

    useEffect(() => {
        api.get<EaReleases>('/ea/releases').then(res => setReleases(res.data)).catch(e => console.error(e));
    }, []);

    const slave = releases?.slave;

    // The file needs the session token, so it comes through the API client rather than a plain link
    const download = async () => {
        if (!slave) return;
        setDownloading(true);
        try {
            const res = await api.get<Blob>('/ea/releases/slave', { responseType: 'blob' });
            const url = URL.createObjectURL(res.data);
            const a = document.createElement('a');
            a.href = url;
            a.download = slave.file;
            a.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (e) {
            console.error(e);
            toast.error('Não foi possível baixar o arquivo.');
        } finally {
            setDownloading(false);
        }
    };

    return (
        <div className="space-y-6">
            <PageHeader
                title="Instalação"
                description="Para copiar com o MetaTrader 5 do seu computador. Ele precisa ficar aberto durante o pregão."
                icon={<Download />}
            />

            <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
                <Card title="EA Slave" description="Copia para a sua conta as operações do portfólio da licença." icon={<Users />} className="lg:col-span-2">
                    <div className="space-y-5">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <p className="text-sm">{slave ? <>Versão <strong>{slave.version}</strong></> : 'Carregando...'}</p>
                            <Button onClick={download} loading={downloading} disabled={!slave}>
                                {!downloading && <Download />} Baixar o EA
                            </Button>
                        </div>
                        <ol className="list-decimal space-y-3 pl-5 text-sm">
                            <li>No MetaTrader 5, abra <strong>Arquivo › Abrir pasta de dados</strong> e copie o arquivo para <code>MQL5\Experts</code>. Depois, em <strong>Navegador</strong>, clique em Atualizar.</li>
                            <li>Em <strong>Ferramentas › Opções › Expert Advisors</strong>, marque <strong>Permitir negociação algorítmica</strong> e <strong>Permitir WebRequest para as URLs listadas</strong>, e adicione <code>{SIGNALS_URL}</code>, exatamente assim, sem porta.</li>
                            <li>Em <Link to="/client" className={linkClass}>Minhas licenças</Link>, abra a licença e clique em <strong>Gerar chave</strong>.</li>
                            <li>Arraste o EA para um gráfico qualquer da conta da licença. Na aba <strong>Comum</strong>, marque <strong>Permitir negociação algorítmica</strong>; em <strong>Entradas</strong>, cole a chave em <em>License key</em>.</li>
                            <li>O gráfico mostra <strong>Hub: conectado</strong>, e a licença aparece como <strong>Copiando</strong> aqui no painel.</li>
                        </ol>
                    </div>
                </Card>

                <Card title="Sem computador ligado" icon={<Server />}>
                    <p className="text-sm text-muted-foreground">
                        Prefere não instalar nada? Na página da licença, use <strong>Hospede a conta com a gente</strong>: o MetaTrader roda
                        num servidor nosso, e você só informa o servidor da corretora e a senha da conta.
                    </p>
                </Card>
            </div>
        </div>
    );
}
