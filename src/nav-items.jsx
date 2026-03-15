import { HomeIcon, MessageCircle, BookOpen, TrendingUp, Zap, MessageSquare, User } from "lucide-react";
import Index from "./pages/Index.jsx";
import AIPage from "./pages/AIPage.jsx";
import DiaryPage from "./pages/DiaryPage.jsx";
import TrendPage from "./pages/TrendPage.jsx";
import ActionPage from "./pages/ActionPage.jsx";
import TreeHolePage from "./pages/TreeHolePage.jsx";
import ProfilePage from "./pages/ProfilePage.jsx";

/**
 * Central place for defining the navigation items. Used for navigation components and routing.
 */
export const navItems = [
  {
    title: "首页",
    to: "/",
    icon: <HomeIcon className="h-4 w-4" />,
    page: <Index />,
  },
  {
    title: "AI陪伴",
    to: "/ai",
    icon: <MessageCircle className="h-4 w-4" />,
    page: <AIPage />,
  },
  {
    title: "日记本",
    to: "/diary",
    icon: <BookOpen className="h-4 w-4" />,
    page: <DiaryPage />,
  },
  {
    title: "趋势",
    to: "/trend",
    icon: <TrendingUp className="h-4 w-4" />,
    page: <TrendPage />,
  },
  {
    title: "行动",
    to: "/action",
    icon: <Zap className="h-4 w-4" />,
    page: <ActionPage />,
  },
  {
    title: "树洞",
    to: "/treehole",
    icon: <MessageSquare className="h-4 w-4" />,
    page: <TreeHolePage />,
  },
  {
    title: "我的",
    to: "/profile",
    icon: <User className="h-4 w-4" />,
    page: <ProfilePage />,
  },
];
