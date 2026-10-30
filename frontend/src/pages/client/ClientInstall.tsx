import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Cloud, Download, Users } from 'lucide-react';
import api, { type EaReleases } from '../../api';
import Card from '../../components/Card';
import CopyField from '../../components/CopyField';
import PageHeader from '../../components/PageHeader';
import { Button } from '../../components/ui/Button';
import { SIGNALS_URL, downloadSlave } from '../../lib/ea';

const linkClass = 'font-medium text-primary underline-offset-4 hover:underline';

// The Slave for a client who runs MetaTrader on their own computer. The activation of each license walks through
// the same steps; this page is for coming back to them
export default function ClientInstall() {
    const [releases, setReleases] = useState<EaReleases | null>(null);
    const [downloading, setDownloading] = useState(false);

    useEffect(() => {
        api.get<EaReleases>('/ea/releases').then(res => setReleases(res.data)).catch(e => console.error(e));
    }, []);

    const slave = releases?.slave;

    return (
        <div className="space-y-6">
            <PageHeader
                title="Instalar o EA"
                description="Para copiar com o MetaTrader 5 do seu computador. Ele precisa ficar aberto durante o pregão."
                icon={<Download />}
            />

            <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
                <Card title="EA da cópia" description="Recebe na sua conta as operações do gestor que você assina." icon={<Users />} className="lg:col-span-2">
                    <div className="space-y-5">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <p className="text-sm">{slave ? <>Versão <strong>{slave.version}</strong></> : 'Carregando...'}</p>
                            <Button className="w-full sm:w-auto" loading={downloading} disabled={!slave}
                                onClick={async () => { setDownloading(true); await downloadSlave(slave); setDownloading(false); }}>
                                {!downloading && <Download />} Baixar o EA
                            </Button>
                        </div>
                        <ol className="list-decimal space-y-3 pl-5 text-sm">
                            <li>No MetaTrader 5, abra <strong>Arquivo › Abrir pasta de dados</strong> e copie o arquivo para <code>MQL5\Experts</code>. Depois, em <strong>Navegador</strong>, clique em Atualizar.</li>
                            <li className="space-y-2">
                                <p>Em <strong>Ferramentas › Opções › Expert Advisors</strong>, marque <strong>Permitir negociação algorítmica</strong> e <strong>Permitir WebRequest para as URLs listadas</strong>, e adicione este endereço, exatamente assim:</p>
                                <CopyField value={SIGNALS_URL} label="URL" />
                            </li>
                            <li>Em <Link to="/client/licenses" className={linkClass}>Minhas cópias</Link>, abra a cópia e gere a sua chave.</li>
                            <li>Arraste o EA para um gráfico qualquer da conta. Na aba <strong>Comum</strong>, marque <strong>Permitir negociação algorítmica</strong>; em <strong>Entradas</strong>, cole a chave em <em>License key</em>.</li>
                            <li>O gráfico mostra <strong>Hub: conectado</strong>, e a cópia aparece como <strong>Copiando</strong> aqui no painel.</li>
                        </ol>
                        <p className="text-sm text-muted-foreground">
                            Prefere ver em vídeo? Os tutoriais do seu gestor estão em <Link to="/client/education" className={linkClass}>Educacional</Link>.
                        </p>
                    </div>
                </Card>

                <Card title="Prefere não instalar nada?" icon={<Cloud />}>
                    <p className="text-sm text-muted-foreground">
                        Com a hospedagem na nuvem, o MetaTrader roda num servidor nosso, ligado o tempo todo: você só informa o
                        servidor da corretora e a senha da conta. Ative em <Link to="/client/licenses" className={linkClass}>Minhas cópias</Link>.
                    </p>
                </Card>
            </div>
        </div>
    );
}
