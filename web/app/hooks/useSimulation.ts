'use client';

import { useContext } from 'react';
import { SimulationContext, SimulationContextValue } from '../components/simulation/SimulationContext';

export function useSimulation(): SimulationContextValue {
  const context = useContext(SimulationContext);
  if (!context) {
    throw new Error('useSimulation must be used within SimulationProvider');
  }
  return context;
}

