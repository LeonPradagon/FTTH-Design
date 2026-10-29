UPDATE users
SET role = 'staff', updated_at = NOW()
WHERE role <> 'admin';
