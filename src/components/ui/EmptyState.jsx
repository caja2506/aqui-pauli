import React from 'react';
import { PackageOpen } from 'lucide-react';

export default function EmptyState({ icon: Icon = PackageOpen, title, message, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-4">
      <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center">
        <Icon className="w-8 h-8 text-slate-300" />
      </div>
      <h3 className="text-lg font-black text-slate-700">{title}</h3>
      {message && <p className="text-sm text-slate-400 text-center max-w-sm">{message}</p>}
      {action && action}
    </div>
  );
}
