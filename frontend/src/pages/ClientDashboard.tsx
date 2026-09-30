
import { Radio, ShieldOff } from 'lucide-react';
import { useWebSocket } from '../hooks/useWebSocket';
import Card from '../components/Card';
import ConnectionBadge from '../components/ConnectionBadge';
import EmptyState from '../components/EmptyState';
import PageHeader from '../components/PageHeader';
import PositionsTable from '../components/PositionsTable';

export default function ClientDashboard() {
    const { status, trades } = useWebSocket();
    const signals = Object.values(trades).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

    return (
        <div className="space-y-6">
            <PageHeader
                title="Meus Sinais"
                description="Posições que estão sendo copiadas para a sua conta."
                icon={<Radio />}
            >
                <ConnectionBadge status={status} />
            </PageHeader>

            {status === 'FORBIDDEN' ? (
                <div className="panel">
                    <EmptyState
                        icon={<ShieldOff />}
                        title="Acompanhamento ao vivo indisponível"
                        description="O painel ainda não exibe sinais para contas de cliente. A cópia das operações acontece diretamente no seu MetaTrader 5."
                    />
                </div>
            ) : (
                <Card title="Sinais ativos" icon={<Radio />} flush>
                    <PositionsTable
                        trades={signals}
                        emptyTitle="Aguardando sinais"
                        emptyDescription="Assim que o gestor abrir uma posição, ela aparece aqui."
                    />
                </Card>
            )}
        </div>
    );
}
