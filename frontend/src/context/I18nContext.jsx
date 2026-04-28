import { createContext, useContext, useState, useEffect } from 'react';

const translations = {
  en: {
    // Navigation
    nav_dashboard: "Dashboard",
    nav_income: "Income",
    nav_expenses: "Expenses",
    nav_subscriptions: "Subscriptions",
    nav_savings: "Savings",
    nav_categories: "Categories",
    nav_settings: "Settings",

    // Settings
    settings_title: "Settings",
    settings_sub: "Configure SmartFin to your workflow",
    settings_tg: "Telegram bot",
    settings_tg_sub: "Connect SmartFin to your Telegram for expense logging",
    settings_tg_connected: "connected",
    settings_currency: "Currency",
    settings_currency_sub: "New Israeli Shekel (₪)",
    settings_cycle: "Budget cycle",
    settings_cycle_sub: "Resets on the 1st of each month",
    settings_cycle_val: "Monthly",
    settings_avg: "Variable income averaging",
    settings_avg_sub: "Rolling 3-month mean used in P&L forecast",
    settings_theme: "Theme",
    settings_theme_dark: "Dark mode — easy on the eyes",
    settings_theme_light: "Light mode — bright and clear",
    settings_theme_btn_dark: "Dark",
    settings_theme_btn_light: "Light",
    settings_lang: "Language",
    settings_lang_sub: "Choose your preferred language",
    settings_account: "Account",
    settings_account_sub: "Manage your SmartFin account",
    settings_signout: "Sign out",

    // Dashboard & Common
    dash_used: "used",
    dash_over_budget: "over budget",
    dash_no_budget: "no budget set",
    dash_over_by: "over by",
    dash_left: "left",
    dash_tx_month: "transactions this month",
  },
  he: {
    // Navigation
    nav_dashboard: "סקירה כללית",
    nav_income: "הכנסות",
    nav_expenses: "הוצאות",
    nav_subscriptions: "מנויים",
    nav_savings: "חסכונות",
    nav_categories: "קטגוריות",
    nav_settings: "הגדרות",

    // Settings
    settings_title: "הגדרות",
    settings_sub: "התאם אישית את SmartFin",
    settings_tg: "בוט טלגרם",
    settings_tg_sub: "חבר את SmartFin לטלגרם לרישום הוצאות",
    settings_tg_connected: "מחובר",
    settings_currency: "מטבע",
    settings_currency_sub: "שקל חדש (₪)",
    settings_cycle: "מחזור תקציב",
    settings_cycle_sub: "מתאפס בראשון לכל חודש",
    settings_cycle_val: "חודשי",
    settings_avg: "ממוצע הכנסות משתנות",
    settings_avg_sub: "ממוצע נע של 3 חודשים בשימוש בתחזית",
    settings_theme: "ערכת נושא",
    settings_theme_dark: "מצב לילה — נעים לעיניים",
    settings_theme_light: "מצב יום — מואר וברור",
    settings_theme_btn_dark: "לילה",
    settings_theme_btn_light: "יום",
    settings_lang: "שפה",
    settings_lang_sub: "בחר את השפה המועדפת עליך",
    settings_account: "חשבון",
    settings_account_sub: "ניהול החשבון שלך",
    settings_signout: "התנתק",

    // Dashboard & Common
    dash_used: "נוצלו",
    dash_over_budget: "חריגה",
    dash_no_budget: "לא הוגדר תקציב",
    dash_over_by: "חריגה של",
    dash_left: "נותרו",
    dash_tx_month: "עסקאות החודש",
  }
};

const I18nContext = createContext();

export function I18nProvider({ children }) {
  const [lang, setLang] = useState(() => localStorage.getItem('smartfin-lang') || 'en');

  useEffect(() => {
    localStorage.setItem('smartfin-lang', lang);
    document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
  }, [lang]);

  const t = (key) => {
    return translations[lang]?.[key] || translations.en[key] || key;
  };

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
