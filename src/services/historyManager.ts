import * as vscode from 'vscode';

export interface HistoryItem {
    id: string;
    timestamp: number;
    type: 'openapi' | 'confluence' | 'combined';
    source: string; // File path or URL
    secondarySource?: string;
    outputPath: string;
    template: string;
}

export class HistoryManager {
    private static readonly TOP_ITEMS_COUNT = 10;
    private static readonly HISTORY_KEY = 'karateDsl.history';

    constructor(private readonly context: vscode.ExtensionContext) { }

    public async addToHistory(item: Omit<HistoryItem, 'id' | 'timestamp'>): Promise<void> {
        const history = this.getHistory();
        const newItem: HistoryItem = {
            ...item,
            id: Math.random().toString(36).substring(2, 11),
            timestamp: Date.now()
        };

        // Remove duplicates of same source/type if they exist
        const filteredHistory = history.filter(h =>
            !(h.type === item.type && h.source === item.source && h.secondarySource === item.secondarySource)
        );

        filteredHistory.unshift(newItem);

        // Keep only top N items
        const limitedHistory = filteredHistory.slice(0, HistoryManager.TOP_ITEMS_COUNT);

        await this.context.globalState.update(HistoryManager.HISTORY_KEY, limitedHistory);
    }

    public getHistory(): HistoryItem[] {
        return this.context.globalState.get<HistoryItem[]>(HistoryManager.HISTORY_KEY, []);
    }

    public async clearHistory(): Promise<void> {
        await this.context.globalState.update(HistoryManager.HISTORY_KEY, []);
    }
}
