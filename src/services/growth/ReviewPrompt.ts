import * as vscode from 'vscode';

export const REVIEW_STATE_KEY = 'karateDsl.reviewPrompt.state';
const FIRST_ASK_AT = 3;
const REASK_AFTER = 10;
const MAX_ASKS = 2;

export interface ReviewState {
    successes: number;
    asks: number;
    nextAskAt: number;
    optedOut: boolean;
}

export const INITIAL_REVIEW_STATE: ReviewState = { successes: 0, asks: 0, nextAskAt: FIRST_ASK_AT, optedOut: false };

/** Pure transition: record a success and say whether to ask now. */
export function recordSuccess(state: ReviewState): { state: ReviewState; ask: boolean } {
    const next = { ...state, successes: state.successes + 1 };
    const ask = !next.optedOut && next.asks < MAX_ASKS && next.successes >= next.nextAskAt;
    return { state: next, ask };
}

export function afterAnswer(state: ReviewState, answer: 'review' | 'later' | 'never'): ReviewState {
    const asks = state.asks + 1;
    if (answer === 'later' && asks < MAX_ASKS) {
        return { ...state, asks, nextAskAt: state.successes + REASK_AFTER };
    }
    return { ...state, asks, optedOut: true };
}

export function reviewUrl(appName: string): string {
    return appName === 'Visual Studio Code'
        ? 'https://marketplace.visualstudio.com/items?itemName=MuthuKumarKoodalingam.karate-test-generator&ssr=false#review-details'
        : 'https://open-vsx.org/extension/MuthuKumarKoodalingam/karate-test-generator/reviews';
}

/** Asks for a short review after a few successful actions. State stays local in globalState; nothing is sent anywhere. */
export class ReviewPrompt {
    private busy = false;

    constructor(private readonly context: vscode.ExtensionContext) {}

    async success(): Promise<void> {
        if (this.busy || !vscode.workspace.getConfiguration('karateDsl.reviewPrompt').get<boolean>('enabled', true)) { return; }
        const stored = this.context.globalState.get<ReviewState>(REVIEW_STATE_KEY) ?? INITIAL_REVIEW_STATE;
        const { state, ask } = recordSuccess(stored);
        await this.context.globalState.update(REVIEW_STATE_KEY, state);
        if (!ask) { return; }
        this.busy = true;
        try {
            const choice = await vscode.window.showInformationMessage(
                'Enjoying free Karate support? A short review helps other Karate users find it.',
                'Leave a review', 'Later', "Don't ask again"
            );
            const answer = choice === 'Leave a review' ? 'review' : choice === "Don't ask again" ? 'never' : 'later';
            await this.context.globalState.update(REVIEW_STATE_KEY, afterAnswer(state, answer));
            if (answer === 'review') {
                await vscode.env.openExternal(vscode.Uri.parse(reviewUrl(vscode.env.appName)));
            }
        } finally {
            this.busy = false;
        }
    }
}
