import { create } from "zustand";

export interface User { id: number; username: string; display_name: string | null; is_admin: boolean; }

interface AuthState {
  token: string | null;
  user: User | null;
  setAuth: (token: string, user: User) => void;
  logout: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  token: localStorage.getItem("ss-token"),
  user: JSON.parse(localStorage.getItem("ss-user") || "null"),
  setAuth: (token, user) => {
    localStorage.setItem("ss-token", token);
    localStorage.setItem("ss-user", JSON.stringify(user));
    set({ token, user });
  },
  logout: () => {
    localStorage.removeItem("ss-token");
    localStorage.removeItem("ss-user");
    set({ token: null, user: null });
  },
}));
