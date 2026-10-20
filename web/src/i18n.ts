// Interface strings for the member's phone, in the member's first language.
import type { Lang } from "../../shared/domain.ts";

const EN = {
  today: "Today", week: "This week", messages: "Messages", noVisits: "No visits today.", checkIn: "Check in", checkOut: "Check out",
  lockout: "Can't get in", held: "held on the household's PayPal", notHeld: "not held yet", paid: "Paid", pending: "Payout on its way",
  statement: "My income statement", inProgress: "In progress since", extraOk: "Household approved up to {n} extra minutes",
  captured: "Taken from the hold", yourPay: "Your pay", via: "via", needs: "Needs", pets: "pets", eco: "fragrance-free kit", deep: "deep clean",
  asked: "You were asked to cover this visit", fee: "Late-cancel fee", releasedNote: "Hold released, nothing charged",
};
type Dict = typeof EN;

const T: Partial<Record<Lang, Dict>> = {
  en: EN,
  pt: { today: "Hoje", week: "Esta semana", messages: "Mensagens", noVisits: "Sem visitas hoje.", checkIn: "Entrada", checkOut: "Saída", lockout: "Não consigo entrar",
    held: "reservado no PayPal da casa", notHeld: "ainda não reservado", paid: "Pago", pending: "Pagamento a caminho", statement: "O meu extrato de rendimentos",
    inProgress: "Em curso desde", extraOk: "A casa aprovou até {n} minutos extra", captured: "Cobrado da reserva", yourPay: "O seu pagamento", via: "via",
    needs: "Precisa", pets: "animais", eco: "produtos sem perfume", deep: "limpeza profunda", asked: "Pediram-lhe para cobrir esta visita", fee: "Taxa de cancelamento tardio", releasedNote: "Reserva libertada, nada cobrado" },
  pl: { today: "Dzisiaj", week: "Ten tydzień", messages: "Wiadomości", noVisits: "Brak wizyt dzisiaj.", checkIn: "Rozpocznij", checkOut: "Zakończ", lockout: "Nie mogę wejść",
    held: "zablokowane na PayPal domu", notHeld: "jeszcze nie zablokowane", paid: "Zapłacone", pending: "Wypłata w drodze", statement: "Moje zestawienie dochodów",
    inProgress: "W toku od", extraOk: "Dom zgodził się na do {n} dodatkowych minut", captured: "Pobrane z blokady", yourPay: "Twoja wypłata", via: "przez",
    needs: "Wymaga", pets: "zwierzęta", eco: "środki bezzapachowe", deep: "gruntowne sprzątanie", asked: "Poproszono cię o zastępstwo", fee: "Opłata za późne odwołanie", releasedNote: "Blokada zwolniona, bez opłat" },
  es: { today: "Hoy", week: "Esta semana", messages: "Mensajes", noVisits: "No hay visitas hoy.", checkIn: "Entrada", checkOut: "Salida", lockout: "No puedo entrar",
    held: "retenido en el PayPal del hogar", notHeld: "aún no retenido", paid: "Pagado", pending: "Pago en camino", statement: "Mi estado de ingresos",
    inProgress: "En curso desde", extraOk: "El hogar aprobó hasta {n} minutos extra", captured: "Cobrado de la retención", yourPay: "Tu pago", via: "por",
    needs: "Necesita", pets: "mascotas", eco: "productos sin perfume", deep: "limpieza profunda", asked: "Te pidieron cubrir esta visita", fee: "Cargo por cancelación tardía", releasedNote: "Retención liberada, sin cargo" },
};

export function t(lang: Lang | undefined, key: keyof Dict, vars: Record<string, string | number> = {}): string {
  const s = (lang && T[lang]?.[key]) || EN[key];
  return s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
}

export function hasUi(lang: Lang): boolean {
  return Boolean(T[lang]);
}
