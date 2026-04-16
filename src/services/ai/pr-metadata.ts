import { roleCompletion } from './completion.js';

export async function generatePRMetadata(diff: string): Promise<string> {
  const prompt = `You are an expert developer. I will provide you with a git diff of the work done in this session.
Please generate a conventional commit message that summarizes ALL the changes comprehensively.
Format it as a single string where the first line is the conventional commit title, followed by a blank line, and then a brief bulleted list of the key changes.

GIT DIFF:
${diff.substring(0, 6000)}`;

  try {
    const response = await roleCompletion('pr-metadata', {
      messages: [{ role: 'user', content: prompt }],
    });

    return response.content?.trim() || 'feat: accumulated session updates';
  } catch (error) {
    console.error('Error generating Smart PR:', error);
    return 'feat: accumulated session updates';
  }
}
