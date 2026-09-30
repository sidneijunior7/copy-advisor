
import { Activity, Layers, LayoutDashboard, Scale, ScrollText, TrendingUp } from 'lucide-react';
import { connectionLabels, useWebSocket } from '../../hooks/useWebSocket';
import ActivityLog from '../../components/ActivityLog';
import Card from '../../components/Card';
import ConnectionBadge from '../../components/ConnectionBadge';
import KPICard from '../../components/KPICard';
import PageHeader from '../../components/PageHeader';
import PositionsTable from '../../components/PositionsTable';

export default function ManagerOverview() {
    const { status, trades, logs } = useWebSocket();
    const openPositions = Object.values(trades).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

    const totalLots = openPositions.reduce((sum, t) => sum + Number(t.volume), 0);
    const strategiesInMarket = new Set(openPositions.map(t => t.strategy_id ?? t.magic)).size;
    const symbols = new Set(openPositions.map(t => t.symbol)).size;

    return (
        <div className="space-y-6">
            <PageHeader
                title="Visão Geral"
                description="Acompanhamento em tempo real das posições das suas contas Master."
                icon={<LayoutDashboard />}
            >
                <ConnectionBadge status={status} />
            </PageHeader>

            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <KPICard
                    label="Servidor"
                    value={connectionLabels[status]}
                    valueClassName={status === 'CONNECTED' ? 'text-success' : status === 'ERROR' ? 'text-destructive' : 'text-warning'}
                    subValue="Canal de sinais ao vivo"
                    icon={<Activity />}
                />
                <KPICard
                    label="Posições abertas"
                    value={openPositions.length}
                    subValue={`${symbols} ${symbols === 1 ? 'ativo' : 'ativos'}`}
                    icon={<TrendingUp />}
                />
                <KPICard
                    label="Estratégias posicionadas"
                    value={strategiesInMarket}
                    subValue="Com posição aberta agora"
                    icon={<Layers />}
                />
                <KPICard
                    label="Volume em aberto"
                    value={totalLots.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}
                    subValue="Lotes nas contas Master"
                    icon={<Scale />}
                />
            </div>

            <Card
                title="Posições abertas"
                description="O que está sendo replicado para os clientes neste momento."
                icon={<TrendingUp />}
                flush
            >
                <PositionsTable trades={openPositions} />
            </Card>

            <Card
                title="Atividade"
                description="Eventos recebidos desde que esta página foi aberta."
                icon={<ScrollText />}
                flush
            >
                <ActivityLog logs={logs} />
            </Card>
        </div>
    );
}
