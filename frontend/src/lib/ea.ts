import { toast } from 'sonner';
import api, { type EaReleases } from '../api';

export const SIGNALS_URL = 'https://signals.trademetric.com.br';

// The Slave's file. It needs the session token, so it comes through the API client rather than a plain link
export async function downloadSlave(slave: EaReleases['slave']) {
    if (!slave) return;
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
    }
}
