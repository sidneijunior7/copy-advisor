// The checkout's steps and the stages the progress bar names. A step is one screen; a stage groups the screens the
// visitor reads as one thing ("Sua conta" is the email check, the password, the name and the CPF). The stages are
// decided once, when the flow starts, so the total on screen never changes halfway
export type StepId =
    | 'contracts'
    | 'email'
    | 'hosting'
    | 'login_password'
    | 'name' // On a phone: the name and the password
    | 'register_password' // Old address of the password screen, now part of 'name': it lands there
    | 'cpf'
    | 'details' // Name, password and CPF on one screen: a wide screen has room for them
    | 'summary';

export type StageId = 'plan' | 'hosting' | 'account' | 'payment' | 'activate';

export const STAGE_LABELS: Record<StageId, string> = {
    plan: 'Plano',
    hosting: 'Como rodar',
    account: 'Sua conta',
    payment: 'Pagamento',
    activate: 'Ativar',
};

export const ACCOUNT_STEPS: StepId[] = ['login_password', 'name', 'register_password', 'cpf', 'details'];

export type FlowOptions = {
    promo: boolean; // Came with a launch code: no plan to choose, only the account and the free days
    loggedIn: boolean;
    hosting: boolean; // The cloud has room: "Como rodar" is a real choice
    emailExists: boolean | null; // Known after the email step
    compact: boolean; // A phone: the sign-up in two screens instead of one
};

// The screens, in order, for who is in the checkout now
export function buildFlow(o: FlowOptions): StepId[] {
    const account: StepId[] = o.loggedIn ? []
        : o.emailExists === true ? ['login_password']
            : o.compact ? ['name', 'cpf'] : ['details'];
    if (o.promo) return [...(o.loggedIn ? [] : ['email' as StepId]), ...account, 'summary'];
    return [
        'contracts',
        ...(o.loggedIn ? [] : ['email' as StepId]), // Right after the simulator: the simulation can be sent to it
        ...(o.hosting ? ['hosting' as StepId] : []),
        ...account,
        'summary',
    ];
}

// The stages for a flow that started as a guest or signed in; a guest who signs in halfway keeps "Sua conta" done
export function buildStages(o: { promo: boolean; startedAsGuest: boolean; hosting: boolean }): StageId[] {
    if (o.promo) return [...(o.startedAsGuest ? ['account' as StageId] : []), 'activate'];
    return ['plan', ...(o.hosting ? ['hosting' as StageId] : []), ...(o.startedAsGuest ? ['account' as StageId] : []), 'payment'];
}

export function stageOf(step: StepId, promo: boolean): StageId {
    if (step === 'summary') return promo ? 'activate' : 'payment';
    if (step === 'contracts') return 'plan';
    if (step === 'email') return promo ? 'account' : 'plan';
    if (step === 'hosting') return 'hosting';
    return 'account';
}

// Where a step from the address (a refresh, the browser's back, a reminder's link) lands: on itself when it is in the
// flow and its data is there, or else on the screen that asks for what is missing
export function resolveStep(wanted: string | null, flow: StepId[], o: { loggedIn: boolean; hasEmail: boolean; promo: boolean }): StepId {
    const first = flow[0];
    const step = wanted as StepId | null;
    if (!step) return first;
    if (ACCOUNT_STEPS.includes(step) || step === 'email') {
        if (o.loggedIn) return 'summary';
        if (step !== 'email' && !o.hasEmail) return flow.includes('email') ? 'email' : first;
    }
    if (!flow.includes(step)) {
        // A phone and a wide screen split the sign-up differently: the same stage on the other one
        if (ACCOUNT_STEPS.includes(step)) return flow.find(s => ACCOUNT_STEPS.includes(s)) ?? first;
        return first;
    }
    if (step === 'summary' && !o.loggedIn) return flow.includes('email') ? (o.hasEmail ? flow[flow.length - 2] : 'email') : first;
    return step;
}

// How far along the bar is: whole stages done, plus a part of the current one for the sign-up's several screens
export function progressOf(step: StepId, flow: StepId[], stages: StageId[], promo: boolean): { index: number; pct: number } {
    const stage = stageOf(step, promo);
    const index = Math.max(0, stages.indexOf(stage));
    const inStage = flow.filter(s => stageOf(s, promo) === stage);
    const within = inStage.length > 1 ? inStage.indexOf(step) / inStage.length : 0;
    return { index, pct: Math.round(((index + 0.5 + within * 0.5) / stages.length) * 100) };
}
