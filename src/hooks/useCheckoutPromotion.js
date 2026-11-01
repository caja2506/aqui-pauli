import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { activeSamples, containsPerfume } from '../../functions/lib/promotions.mjs';

export function useCheckoutPromotion(items) {
  const [options, setOptions] = useState([]);
  const [eligibleKey, setEligibleKey] = useState(null);
  const key = JSON.stringify([...new Set(items.map(i => i.productId))].sort());
  useEffect(() => {
    let alive = true;
    getDoc(doc(db, 'config', 'decants')).then(s => { if (alive) setOptions(activeSamples(s.data())); })
      .catch(() => { if (alive) setOptions([]); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!options.length) return;
    let alive = true;
    async function check() {
      const products = await Promise.all(JSON.parse(key).map(async id => (await getDoc(doc(db, 'products', id))).data()));
      const eligible = await containsPerfume(products, async id => (await getDoc(doc(db, 'categories', id))).data()?.parentId);
      if (alive) setEligibleKey(eligible ? key : null);
    }
    check().catch(() => { if (alive) setEligibleKey(null); });
    return () => { alive = false; };
  }, [key, options]);
  return eligibleKey === key ? options : [];
}
