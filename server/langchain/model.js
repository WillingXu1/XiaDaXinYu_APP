import { ChatOpenAI } from '@langchain/openai';

export const createAgentModel = ({
  apiKey = process.env.DEEPSEEK_API_KEY,
  modelName = process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  temperature = 0.5
} = {}) => {
  if (!apiKey) {
    return null;
  }

  return new ChatOpenAI({
    apiKey,
    model: modelName,
    temperature,
    configuration: {
      baseURL: 'https://api.deepseek.com'
    }
  });
};
