/** The model family a model name belongs to: opus, sonnet, haiku, fable, or other. Dependency-free so pure modules can import it. */
export function family(model: string | undefined): string {
    const m = /(opus|sonnet|haiku|fable)/i.exec(model || '');
    return m ? m[1].toLowerCase() : 'other';
}
