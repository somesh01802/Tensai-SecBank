import { api } from "./client"

export interface ChatTurn { role: "user" | "assistant"; content: string }

export const chatbotApi = {
  send: async (message: string, history: ChatTurn[] = []) => {
    const { data } = await api.post<{ reply: string; source: string }>("/chatbot/message", {
      message,
      history: history.slice(-8)
    })
    return data
  }
}
