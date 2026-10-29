import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './auth/auth-context'
import './index.css'
import RootApp from './RootApp'
import { Toaster } from './components/ui/sonner'
import { TooltipProvider } from './components/ui/tooltip'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 10000,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider delay={200}>
      <AuthProvider>
        <BrowserRouter>
          <RootApp />
        </BrowserRouter>
      </AuthProvider>
    </TooltipProvider>
    <Toaster theme="dark" position="bottom-right" richColors />
  </QueryClientProvider>,
)
