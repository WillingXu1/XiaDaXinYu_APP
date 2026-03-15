import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { navItems } from "./nav-items";
import { AppProvider, useApp } from "./context/AppContext";
import BottomNav from "./components/BottomNav";
import LoginPage from "./pages/LoginPage";

const queryClient = new QueryClient();

// 受保护的路由组件
const ProtectedRoute = ({ children }) => {
  const { user } = useApp();
  return user ? children : <Navigate to="/login" replace />;
};

// 登录页面路由组件
const LoginRoute = () => {
  const { user, login } = useApp();
  
  // 如果用户已登录，重定向到首页
  if (user) {
    return <Navigate to="/" replace />;
  }
  
  return <LoginPage onLogin={login} />;
};

const AppContent = () => {
  const { user } = useApp();
  
  return (
    <HashRouter>
      <div className="relative min-h-screen">
        {/* 背景遮罩层，确保内容可读性 */}
        <div className="fixed inset-0 bg-black bg-opacity-30 z-0"></div>
        <div className="relative z-10">
          <Routes>
            {/* 登录页面 */}
            <Route path="/login" element={<LoginRoute />} />
            
            {/* 受保护的应用页面 */}
            {navItems.map(({ to, page }) => (
              <Route 
                key={to} 
                path={to} 
                element={
                  <ProtectedRoute>
                    {page}
                  </ProtectedRoute>
                } 
              />
            ))}
            
            {/* 默认重定向到首页 */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          
          {/* 底部导航栏 - 仅在已登录状态下显示 */}
          {user && <BottomNav />}
        </div>
      </div>
    </HashRouter>
  );
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AppProvider>
      <TooltipProvider>
        <Toaster />
        <AppContent />
      </TooltipProvider>
    </AppProvider>
  </QueryClientProvider>
);

export default App;
